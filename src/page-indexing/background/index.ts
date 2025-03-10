import createResolvable, { Resolvable } from '@josephg/resolvable'
import StorageManager from '@worldbrain/storex'
import {
    normalizeUrl,
    isFileUrl,
} from '@worldbrain/memex-common/lib/url-utils/normalize'
import { isTermsField } from '@worldbrain/memex-common/lib/storage/utils'
import {
    ContentFingerprint,
    ContentLocatorFormat,
    ContentLocatorType,
    LocationSchemeType,
    FingerprintSchemeType,
} from '@worldbrain/memex-common/lib/personal-cloud/storage/types'
import {
    ContentIdentifier,
    ContentLocator,
    ExtractedPDFData,
    PageDoc,
} from '@worldbrain/memex-common/lib/page-indexing/types'
import {
    buildBaseLocatorUrl,
    fingerprintsEqual,
    isMemexPageAPdf,
} from '@worldbrain/memex-common/lib/page-indexing/utils'

import PageStorage from './storage'
import {
    PageAddRequest,
    PipelineReq,
    VisitInteraction,
    PipelineRes,
} from 'src/search/types'
import { extractUrlParts } from '@worldbrain/memex-common/lib/url-utils/extract-parts'
import pagePipeline from '@worldbrain/memex-common/lib/page-indexing/pipeline'
import { initErrHandler } from 'src/search/storage'
import { Page, PageCreationProps, PageCreationOpts } from 'src/search'
import { DexieUtilsPlugin } from 'src/search/plugins'
import analysePage, {
    PageAnalysis,
} from 'src/page-analysis/background/analyse-page'
import TabManagementBackground from 'src/tab-management/background'
import PersistentPageStorage from './persistent-storage'
import {
    StoredContentType,
    PageIndexingInterface,
    InitContentIdentifierParams,
    InitContentIdentifierReturns,
    WaitForContentIdentifierReturns,
} from './types'
import {
    remoteFunctionWithExtraArgs,
    registerRemoteFunctions,
    remoteFunctionWithoutExtraArgs,
} from '../../util/webextensionRPC'
import type { BrowserSettingsStore } from 'src/util/settings'
import { isUrlSupported } from '../utils'
import {
    enforceTrialPeriod30Days,
    updatePageCounter,
} from 'src/util/subscriptions/storage'
import type { PageDataResult } from '@worldbrain/memex-common/lib/page-indexing/fetch-page-data/types'
import { doesUrlPointToPdf } from '@worldbrain/memex-common/lib/page-indexing/utils'
import { AuthRemoteFunctionsInterface } from 'src/authentication/background/types'
import { AuthBackground } from 'src/authentication/background'
import { AuthServices } from 'src/services/types'
import { PkmSyncInterface } from 'src/pkm-integrations/background/types'

interface ContentInfo {
    /** Timestamp in ms of when this data was stored. */
    asOf: number
    locators: ContentLocator[]
    primaryIdentifier: ContentIdentifier // this is the one we store in the DB
    aliasIdentifiers: ContentIdentifier[] // these are the ones of the other URLs pointing to the primaryNormalizedUrl
}

export interface LocalPageIndexingSettings {
    /** Remember which pages are already indexed in which tab, so we only add one visit per page + tab. */
    indexedTabPages: { [tabId: number]: { [fullPageUrl: string]: true } }
    /** Will contain multiple entries for the same content info because of multiple normalized URLs pointing to one. */
    pageContentInfo: { [normalizedUrl: string]: ContentInfo }
}

export class PageIndexingBackground {
    static ONE_WEEK_MS = 604800000

    storage: PageStorage
    persistentStorage: PersistentPageStorage
    remoteFunctions: PageIndexingInterface<'provider'>

    // See `this.getIdentifierResolvableForTabPage` for how this is used
    private identifiersForTabPages: {
        [tabId: number]: {
            [fullPageUrl: string]: Resolvable<ContentIdentifier>
        }
    } = {}

    constructor(
        public options: {
            authBG: AuthRemoteFunctionsInterface
            tabManagement: TabManagementBackground
            storageManager: StorageManager
            persistentStorageManager: StorageManager
            pageIndexingSettingsStore: BrowserSettingsStore<
                LocalPageIndexingSettings
            >
            fetchPageData: (fullPageUrl: string) => Promise<PageDataResult>
            fetchPdfData: (fullPageUrl: string) => Promise<ExtractedPDFData>
            createInboxEntry: (normalizedPageUrl: string) => Promise<void>
            getNow: () => number
            pkmSyncBG?: PkmSyncInterface
        },
    ) {
        this.storage = new PageStorage({
            storageManager: options.storageManager,
            pkmSyncBG: options.pkmSyncBG,
        })
        this.persistentStorage = new PersistentPageStorage({
            storageManager: options.persistentStorageManager,
        })

        this.remoteFunctions = {
            initContentIdentifier: remoteFunctionWithExtraArgs((info, params) =>
                this.initContentIdentifier({
                    ...params,
                    tabId: params.tabId ?? info.tab?.id,
                }),
            ),
            waitForContentIdentifier: remoteFunctionWithExtraArgs(
                (info, params) =>
                    this.waitForContentIdentifier({
                        ...params,
                        tabId: params.tabId ?? info.tab?.id,
                    }),
            ),
            lookupPageTitleForUrl: remoteFunctionWithoutExtraArgs(
                this.lookupPageTitleForUrl,
            ),
        }
    }

    setupRemoteFunctions() {
        registerRemoteFunctions(this.remoteFunctions)
    }

    lookupPageTitleForUrl: PageIndexingInterface<
        'provider'
    >['lookupPageTitleForUrl']['function'] = async ({ fullPageUrl }) => {
        const pageData = await this.storage.getPage(fullPageUrl)
        return pageData?.fullTitle ?? null
    }

    async initContentIdentifier(
        params: InitContentIdentifierParams,
    ): Promise<InitContentIdentifierReturns> {
        const resolvable =
            params.tabId &&
            this.getIdentifierResolvableForTabPage({
                tabId: params.tabId,
                fullUrl: params.locator.originalLocation,
                forceNewResolvable: true,
            })

        const regularNormalizedUrl = normalizeUrl(
            params.locator.originalLocation,
        )
        const regularIdentifier: ContentIdentifier = {
            normalizedUrl: regularNormalizedUrl,
            fullUrl: params.locator.originalLocation,
        }

        if (!params.fingerprints.length) {
            // This is where regular, non-PDF pages leave
            resolvable?.resolve?.(regularIdentifier)
            return regularIdentifier
        }

        const pageContentInfo = await this.getContentInfoForPages()

        let contentInfo = pageContentInfo[regularNormalizedUrl]
        let stored: {
            identifier: ContentIdentifier
            locators: ContentLocator[]
        }

        if (
            !contentInfo ||
            Date.now() - contentInfo.asOf > PageIndexingBackground.ONE_WEEK_MS
        ) {
            stored = await this.storage.getContentIdentifier({
                fingerprints: params.fingerprints,
            })

            if (!stored) {
                const baseLocatorUrl = buildBaseLocatorUrl(
                    params.fingerprints[0].fingerprint,
                    params.locator.format,
                )
                contentInfo = {
                    asOf: Date.now(),
                    primaryIdentifier: {
                        fullUrl: baseLocatorUrl,
                        normalizedUrl: normalizeUrl(baseLocatorUrl),
                    },
                    locators: [],
                    aliasIdentifiers: [regularIdentifier],
                }
            } else {
                // Stored content ID exists for these fingerprints, so attempt grabbing info
                //   from cache using the stored ID, or seed it if miss
                contentInfo = pageContentInfo[
                    stored.identifier.normalizedUrl
                ] ?? {
                    asOf: Date.now(),
                    primaryIdentifier: stored.identifier,
                    locators: stored.locators,
                    aliasIdentifiers: stored.locators.map((locator) => ({
                        normalizedUrl: normalizeUrl(locator.originalLocation),
                        fullUrl: locator.originalLocation,
                    })),
                }
            }
        }

        pageContentInfo[regularNormalizedUrl] = contentInfo
        pageContentInfo[
            contentInfo.primaryIdentifier.normalizedUrl
        ] = contentInfo

        // Keep track of the orig ID passed into this function, as an alias ID of the main content info
        if (
            !contentInfo.aliasIdentifiers.find(
                (identifier) =>
                    identifier.normalizedUrl === regularNormalizedUrl,
            )
        ) {
            contentInfo.aliasIdentifiers.push(regularIdentifier)
        }

        // Keep track of new fingerprints as locators on the main content info
        let hasNewLocators = false

        // This mainly covers the case of not creating lots of locators for local PDFs referred to via in-memory object URLs, which change every time they're dragged into the browser
        const unsupportedLocationWithExistingLocator =
            contentInfo.aliasIdentifiers.length > 0 &&
            !isUrlSupported({ fullUrl: params.locator.originalLocation })

        for (const fingerprint of params.fingerprints) {
            if (
                contentInfo.locators.find(
                    (locator) =>
                        fingerprintsEqual(locator, fingerprint) &&
                        (locator.originalLocation ===
                            params.locator.originalLocation ||
                            unsupportedLocationWithExistingLocator),
                )
            ) {
                continue
            }
            hasNewLocators = true

            const isFile = isFileUrl(params.locator.originalLocation)
            contentInfo.locators.push({
                ...params.locator,
                location: normalizeUrl(params.locator.originalLocation),
                locationType: isFile
                    ? ContentLocatorType.Local
                    : ContentLocatorType.Remote,
                locationScheme: isFile
                    ? LocationSchemeType.FilesystemPathV1
                    : LocationSchemeType.NormalizedUrlV1,
                fingerprint: fingerprint.fingerprint,
                fingerprintScheme: fingerprint.fingerprintScheme,
                normalizedUrl: contentInfo.primaryIdentifier.normalizedUrl,
                primary: true,
                valid: true,
                version: 0,
                lastVisited: this.options.getNow(),
            })
        }
        await this.options.pageIndexingSettingsStore.set(
            'pageContentInfo',
            pageContentInfo,
        )
        if (stored && hasNewLocators) {
            await this.storeLocators(contentInfo.primaryIdentifier)
        }

        resolvable?.resolve?.(contentInfo.primaryIdentifier)
        return contentInfo.primaryIdentifier
    }

    waitForContentIdentifier = async (params: {
        tabId: number
        fullUrl: string
        timeout?: number
    }): Promise<WaitForContentIdentifierReturns> => {
        // TODO: Try and simplify this logic. Essentially, it was easily possible to get into states where the resolvable would
        //  never get resolved (tab where the content-script doesn't run, and thus doesn't call initContentIdentifier), so solving
        //  that by throwing an error after a timeout.
        const resolvable = new Promise<['resolved', ContentIdentifier]>(
            async (resolve) => {
                const identifier = await this.getIdentifierResolvableForTabPage(
                    params,
                )
                resolve(['resolved', identifier])
            },
        )

        const timeout = new Promise<['timeout']>((resolve) =>
            setTimeout(() => {
                resolve(['timeout'])
            }, params.timeout ?? 2500),
        )

        const [result, contentIdentifier] = await Promise.race([
            resolvable,
            timeout,
        ])
        if (result === 'timeout') {
            throw new Error(
                `Could not resolve identifier in time for tab: ${params.tabId}, page: ${params.fullUrl}`,
            )
        }
        return contentIdentifier
    }

    private async getContentInfoForPages(): Promise<
        LocalPageIndexingSettings['pageContentInfo']
    > {
        return (
            (await this.options.pageIndexingSettingsStore.get(
                'pageContentInfo',
            )) ?? {}
        )
    }

    private async getIndexedTabPages(): Promise<
        LocalPageIndexingSettings['indexedTabPages']
    > {
        return (
            (await this.options.pageIndexingSettingsStore.get(
                'indexedTabPages',
            )) ?? {}
        )
    }

    async getContentFingerprints(
        contentIdentifier: Pick<ContentIdentifier, 'normalizedUrl'>,
    ) {
        const contentInfo = await this.getContentInfoForPages()
        return contentInfo[contentIdentifier.normalizedUrl]?.locators.map(
            (locator): ContentFingerprint => ({
                fingerprintScheme: locator.fingerprintScheme,
                fingerprint: locator.fingerprint,
            }),
        )
    }

    /**
     * Adds/updates a page + associated visit (pages never exist without either an assoc.
     * visit or bookmark in current model).
     */
    async addPage({
        visits = [],
        pageDoc,
    }: Partial<PageAddRequest>): Promise<void> {
        const { favIconURI, ...pageData } = await pagePipeline({
            pageDoc,
        })

        await this.createOrUpdatePage(pageData)

        // Create Visits for each specified time, or a single Visit for "now" if no assoc event
        visits = !visits.length ? [Date.now()] : visits
        await this.storage.createVisitsIfNeeded(pageData.url, visits)
    }

    async addFavIconIfNeeded(url: string, favIcon: string) {
        const { hostname } = extractUrlParts(url)

        return this.storage.createFavIconIfNeeded(hostname, favIcon)
    }

    async addPageTerms(pipelineReq: PipelineReq): Promise<void> {
        const pageData = await pagePipeline(pipelineReq)
        await this.createOrUpdatePage(pageData)
    }

    async _deletePages(query: object) {
        const pages = await this.options.storageManager
            .collection('pages')
            .findObjects<PipelineRes>(query)

        return Promise.all(
            pages.map((page) =>
                new Page(this.options.storageManager, page).delete(),
            ),
        ).catch(initErrHandler())
    }

    async delPages(urls: string[]): Promise<{ info: any }[]> {
        const normalizedUrls: string[] = urls.map((url) => normalizeUrl(url))

        return this._deletePages({ url: { $in: normalizedUrls } })
    }

    async delPagesByDomain(url: string): Promise<void> {
        await this._deletePages({ domain: url })
    }

    // WARNING: Inefficient; goes through entire table
    async delPagesByPattern(pattern: string | RegExp): Promise<void> {
        return this.options.storageManager.operation(
            DexieUtilsPlugin.REGEXP_DELETE_OP,
            {
                collection: 'pages',
                fieldName: 'url',
                pattern,
            },
        )
    }

    async addVisit(url: string, time = Date.now()) {
        const pageExists = await this.storage.pageExists(url)
        if (!pageExists) {
            throw new Error(`Cannot add visit for non-existent page: ${url}`)
        }
        await this.storage.addPageVisit(url, time).catch(initErrHandler())
    }

    /**
     * Updates an existing specified visit with interactions data.
     */
    async updateTimestampMeta(
        url: string,
        time: number,
        data: Partial<VisitInteraction>,
    ) {
        return this.storage.updateVisitMetadata({ url, time }, data)
    }

    async addFavIcon(url: string, favIconURI: string | Blob) {
        const { hostname } = extractUrlParts(url)

        await this.storage
            .createOrUpdateFavIcon(hostname, favIconURI)
            .catch(initErrHandler())
    }

    async domainHasFavIcon(ambiguousUrl: string) {
        const db = this.options.storageManager
        const { hostname } = extractUrlParts(ambiguousUrl)

        const res = await db
            .collection('favIcons')
            .findOneObject({ hostname })
            .catch(initErrHandler())
        return res != null
    }

    private removeAnyUnregisteredFields(pageData: PipelineRes): PipelineRes {
        const clonedData = { ...pageData }

        for (const field in clonedData) {
            if (
                !this.storage.collections['pages'].fields[field] &&
                !isTermsField({ collection: 'pages', field })
            ) {
                delete clonedData[field]
            }
        }

        return clonedData
    }

    async createOrUpdatePage(
        pageData: PipelineRes,
        opts: PageCreationOpts = {},
    ) {
        const { favIconURI } = pageData
        pageData = this.removeAnyUnregisteredFields(pageData)
        const pageContentInfo = await this.getContentInfoForPages()

        const contentIdentifier =
            pageContentInfo[pageData.url]?.primaryIdentifier
        if (contentIdentifier) {
            pageData.fullUrl = contentIdentifier.fullUrl
            pageData.url = contentIdentifier.normalizedUrl
        }
        const normalizedUrl = pageData.url

        const existingPage = await this.storage.getPage(normalizedUrl)
        if (existingPage) {
            await this.storage.updatePage(pageData, existingPage)
        } else {
            await this.storage.createPage(pageData, pageContentInfo)
        }

        if (contentIdentifier) {
            await this.storeLocators(contentIdentifier)
        }

        if (opts.addInboxEntryOnCreate && !existingPage) {
            await this.options.createInboxEntry(pageData.fullUrl)
        }

        if (favIconURI != null) {
            await this.addFavIconIfNeeded(pageData.url, favIconURI)
        }
    }

    async storeLocators(identifier: ContentIdentifier) {
        const pageContentInfo = await this.getContentInfoForPages()
        const contentInfo = pageContentInfo[identifier.normalizedUrl]
        if (!contentInfo) {
            return
        }
        await this.storage.storeLocators({
            identifier: contentInfo.primaryIdentifier,
            locators: contentInfo.locators,
        })
    }

    private async storeDocContent(
        normalizedUrl: string,
        analysis: Pick<
            PageAnalysis,
            'htmlBody' | 'pdfMetadata' | 'pdfPageTexts'
        >,
    ) {
        if (analysis.htmlBody) {
            await this.persistentStorage.createOrUpdatePage({
                normalizedUrl,
                storedContentType: StoredContentType.HtmlBody,
                content: analysis.htmlBody,
            })
        } else if (analysis.pdfMetadata && analysis.pdfPageTexts) {
            for (const key of Object.keys(analysis.pdfMetadata)) {
                if (analysis.pdfMetadata[key] === null) {
                    delete analysis.pdfMetadata[key]
                }
            }

            await this.persistentStorage.createOrUpdatePage({
                normalizedUrl,
                storedContentType: StoredContentType.PdfContent,
                content: {
                    metadata: analysis.pdfMetadata,
                    pageTexts: analysis.pdfPageTexts,
                },
            })
        }
    }

    indexPage = async (
        props: PageCreationProps,
        opts: PageCreationOpts = {},
    ): Promise<{ fullUrl: string }> => {
        // PDF pages should always have their tab IDs set, so don't fetch them from the tabs API
        //   TODO: have PDF pages pass down their original URLs here, instead of the memex.cloud/ct/ ones,
        //     so we don't have to do this dance

        if (!isMemexPageAPdf({ url: props.fullUrl })) {
            const foundTabId = await this._findTabId(props.fullUrl)
            if (foundTabId) {
                props.tabId = foundTabId
            } else {
                delete props.tabId
            }
        }

        let pageData = await (props.tabId != null
            ? this.processPageDataFromTab(props)
            : this.processPageDataFromUrl(props))

        if (pageData.isExisting) {
            return { fullUrl: pageData.fullUrl }
        }

        // Override title with in-page CS derived title for telegram pages - TODO: Move this somewhere else
        if (
            (props.fullUrl.includes('web.telegram.org/') ||
                props.fullUrl.includes('x.com/') ||
                props.fullUrl.includes('twitter.com/')) &&
            props.metaData.pageTitle
        ) {
            pageData.fullTitle = props.metaData.pageTitle
        }

        await this.createOrUpdatePage(pageData, opts)

        if (props.visitTime) {
            await this.storage.addPageVisit(
                pageData.url,
                this._getTime(props.visitTime),
            )
            // await this.markTabPageAsIndexed({
            //     tabId: props.tabId,
            //     fullPageUrl: processedPageData.fullUrl,
            // })
        }

        try {
            const signupDate = new Date(
                await (await this.options.authBG.getCurrentUser()).creationTime,
            ).getTime()
            const isTrial = await enforceTrialPeriod30Days(signupDate)

            if (!isTrial && !props.skipUpdatePageCount) {
                await updatePageCounter()
            }
        } catch (error) {
            console.error('error in updatePageCounter', error)
        }
        // Note that we're returning URLs as they could have changed in the case of PDFs
        return {
            fullUrl: pageData.fullUrl,
        }
    }

    private async processPageDataFromTab(
        props: PageCreationProps,
    ): Promise<PipelineRes & { isExisting?: boolean }> {
        if (props.tabId == null) {
            throw new Error(
                `No tabID provided to extract content: ${props.fullUrl}`,
            )
        }
        const isPdf = doesUrlPointToPdf(props.fullUrl)

        const existingPage = await this.storage.getPage(props.fullUrl)
        if (existingPage) {
            return { ...existingPage, isExisting: true }
        }

        let originalUrl = props.fullUrl
        // PDFs have their fullUrl set to the memex.cloud/ct/ URL, so we need to get the underlying
        //  URL from stored page content info locators to properly process URL data
        if (isPdf) {
            const pageContentInfo = await this.getContentInfoForPages()
            let contentInfo = pageContentInfo[normalizeUrl(props.fullUrl)]
            if (!contentInfo?.locators.length) {
                throw new Error('Could not find content info for PDF page')
            }
            const latestLocator = contentInfo.locators.sort(
                (a, b) => (b.lastVisited ?? 0) - (a.lastVisited ?? 0),
            )[0]

            // Only take the original location for remote PDFs
            //  - local PDFs use an in-memory location, which we'd rather use the memex.cloud/ct/ for URL data
            if (!latestLocator.originalLocation.startsWith('blob:')) {
                originalUrl = latestLocator.originalLocation
            }
        }

        const includeFavIcon = !(await this.domainHasFavIcon(props.fullUrl))
        const analysis = await analysePage({
            tabId: props.tabId,
            tabManagement: this.options.tabManagement,
            includeContent: 'metadata-with-full-text',
            includeFavIcon,
            url: props.fullUrl,
        })

        const pageData = await pagePipeline({
            pageDoc: { ...analysis, url: props.fullUrl, originalUrl },
        })
        await this.storeDocContent(normalizeUrl(pageData.url), analysis)

        if (analysis.favIconURI) {
            await this.storage.createFavIconIfNeeded(
                pageData.hostname,
                analysis.favIconURI,
            )
        }

        return pageData
    }

    private async processPageDataFromUrl(
        props: PageCreationProps,
    ): Promise<PipelineRes & { isExisting?: boolean }> {
        const pageDoc: PageDoc = {
            url: props.fullUrl,
            originalUrl: props.fullUrl,
            content: {},
        }
        const isPdf = doesUrlPointToPdf(props.fullUrl)

        if (!isPdf) {
            const existingPage = await this.storage.getPage(props.fullUrl)
            if (existingPage) {
                return { ...existingPage, isExisting: true }
            }

            const {
                content,
                htmlBody,
                favIconURI,
            } = await this.options.fetchPageData(props.fullUrl)
            await this.storeDocContent(normalizeUrl(props.fullUrl), {
                htmlBody,
            })

            pageDoc.favIconURI = favIconURI
            pageDoc.content.title = content.title
            pageDoc.content.fullText = content.fullText
        } else {
            const pdfData = await this.options.fetchPdfData(props.fullUrl)
            const baseLocator = await this.initContentIdentifier({
                locator: {
                    format: ContentLocatorFormat.PDF,
                    originalLocation: props.fullUrl,
                },
                fingerprints: pdfData.pdfMetadata.fingerprints.map(
                    (fingerprint) => ({
                        fingerprintScheme: FingerprintSchemeType.PdfV1,
                        fingerprint,
                    }),
                ),
            })

            const existingPage = await this.storage.getPage(baseLocator.fullUrl)
            if (existingPage) {
                return { ...existingPage, isExisting: true }
            }

            await this.storeDocContent(baseLocator.normalizedUrl, {
                pdfMetadata: pdfData.pdfMetadata,
                pdfPageTexts: pdfData.pdfPageTexts,
            })

            // Replace the remote PDF URL with the base locator's memex.cloud/ct/ URL
            pageDoc.url = baseLocator.fullUrl
            pageDoc.content.title = pdfData.title
            pageDoc.content.fullText = pdfData.fullText
        }

        return pagePipeline({ pageDoc })
    }

    private async _findTabId(fullUrl: string) {
        let foundTabId = await this.options.tabManagement.findTabIdByFullUrl(
            fullUrl,
        )
        if (foundTabId) {
            return foundTabId
        }

        const pageContentInfo = await this.getContentInfoForPages()
        const contentInfo = pageContentInfo[normalizeUrl(fullUrl)]
        for (const locator of contentInfo?.locators ?? []) {
            foundTabId = await this.options.tabManagement.findTabIdByFullUrl(
                locator.originalLocation,
            )
            if (foundTabId) {
                return foundTabId
            }
        }
        return null
    }

    async indexTestPage(props: PageCreationProps) {
        const pageData = await pagePipeline({
            pageDoc: { url: props.fullUrl, content: {} },
        })

        await this.storage.createPageIfNotExists(pageData)

        if (props.visitTime) {
            await this.storage.addPageVisit(
                pageData.url,
                this._getTime(props.visitTime),
            )
        }
    }

    private async isTabPageIndexed(params: {
        tabId: number
        fullPageUrl: string
    }): Promise<boolean> {
        const indexedTabPages = await this.getIndexedTabPages()
        return indexedTabPages[params.tabId]?.[params.fullPageUrl] ?? false
    }

    private async markTabPageAsIndexed({
        tabId,
        fullPageUrl,
    }: {
        tabId?: number
        fullPageUrl: string
    }) {
        if (!tabId) {
            return
        }

        const indexedTabPages = await this.getIndexedTabPages()
        indexedTabPages[tabId] = indexedTabPages[tabId] ?? {}
        indexedTabPages[tabId][fullPageUrl] = true
        await this.options.pageIndexingSettingsStore.set(
            'indexedTabPages',
            indexedTabPages,
        )
    }

    async handleTabClose(event: { tabId: number }) {
        const indexedTabPages = await this.getIndexedTabPages()
        delete indexedTabPages[event.tabId]
        await this.options.pageIndexingSettingsStore.set(
            'indexedTabPages',
            indexedTabPages,
        )

        delete this.identifiersForTabPages[event.tabId]
    }

    findLocatorsByNormalizedUrl(normalizedUrl: string) {
        return this.storage.findLocatorsByNormalizedUrl(normalizedUrl)
    }

    private getIdentifierResolvableForTabPage(params: {
        tabId: number
        fullUrl: string
        forceNewResolvable?: boolean
    }) {
        const resolvablesForTab =
            this.identifiersForTabPages[params.tabId] ?? {}
        this.identifiersForTabPages[params.tabId] = resolvablesForTab

        const newResolvable = createResolvable<ContentIdentifier>()
        const resolvable = params.forceNewResolvable
            ? newResolvable
            : resolvablesForTab[params.fullUrl] ?? newResolvable

        resolvablesForTab[params.fullUrl] = resolvable

        return resolvable
    }

    private _getTime(time?: number | '$now') {
        if (!time && time !== 0) {
            return
        }
        return time !== '$now' ? time : this.options.getNow()
    }
}
