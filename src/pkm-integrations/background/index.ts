import { makeRemotelyCallable } from '../../util/webextensionRPC'
import { checkServerStatus } from '../../backup-restore/ui/utils'
import { MemexLocalBackend } from '../background/backend'
import { PkmSyncInterface } from './types'
import { marked } from 'marked'
import TurndownService from 'turndown'
import { browser } from 'webextension-polyfill-ts'
import moment from 'moment'
import replaceImgSrcWithFunctionOutput from '@worldbrain/memex-common/lib/annotations/replaceImgSrcWithCloudAddress'
import { pageTitle } from 'src/sidebar-overlay/sidebar/selectors'
export class PKMSyncBackgroundModule {
    backend: MemexLocalBackend
    remoteFunctions: PkmSyncInterface

    backendNew: MemexLocalBackend

    constructor() {
        this.backendNew = new MemexLocalBackend({
            url: 'http://localhost:11922',
        })

        this.remoteFunctions = {
            pushPKMSyncUpdate: async (item) => {
                await this.processChanges(item)
            },
        }
    }

    setupRemoteFunctions() {
        makeRemotelyCallable({
            ...this.remoteFunctions,
        })
    }

    private async getValidFolders() {
        const data = await browser.storage.local.get('PKMSYNCpkmFolders')
        const folders = data.PKMSYNCpkmFolders || {}

        const validFolders = {
            logSeq: !!folders.logSeqFolder,
            obsidian: !!folders.obsidianFolder,
        }

        return validFolders
    }

    async processChanges(item) {
        const validFolders = await this.getValidFolders()

        // Process for LogSeq if valid
        if (validFolders.logSeq) {
            // let syncOnlyAnnotatedPagesLogseq = await browser.storage.local.get(
            //     'PKMSYNCsyncOnlyAnnotatedPagesLogseq',
            // )

            const PKMSYNCtitleformatLogseq = await browser.storage.local.get(
                'PKMSYNCtitleformatLogseq',
            )
            const PKMSYNCdateformatLogseq = await browser.storage.local.get(
                'PKMSYNCdateformatLogseq',
            )
            const customTagsLogseq = await browser.storage.local.get(
                'PKMSYNCcustomTagsLogseq',
            )
            try {
                await this.createPageUpdate(
                    item,
                    'logseq',
                    PKMSYNCdateformatLogseq.PKMSYNCdateformatLogseq,
                    customTagsLogseq.PKMSYNCcustomTagsLogseq,
                    PKMSYNCtitleformatLogseq.PKMSYNCtitleformatLogseq,
                )
            } catch (e) {
                console.error('error', e)
            }
            // Logic to process changes for LogSeq
            // For example: await this.processForLogSeq(page);
        }

        // Process for Obsidian if valid
        if (validFolders.obsidian) {
            // let syncOnlyAnnotatedPagesObsidian = await browser.storage.local.get(
            //     'PKMSYNCsyncOnlyAnnotatedPagesObsidian',
            // )
            const PKMSYNCtitleformatObsidian = await browser.storage.local.get(
                'PKMSYNCtitleformatObsidian',
            )
            const PKMSYNCdateformatObsidian = await browser.storage.local.get(
                'PKMSYNCdateformatObsidian',
            )
            const customTagsObsidian = await browser.storage.local.get(
                'PKMSYNCcustomTagsObsidian',
            )
            try {
                await this.createPageUpdate(
                    item,
                    'obsidian',
                    PKMSYNCdateformatObsidian.PKMSYNCdateformatObsidian,
                    customTagsObsidian.PKMSYNCcustomTagsObsidian,
                    PKMSYNCtitleformatObsidian.PKMSYNCtitleformatObsidian,
                )
            } catch (e) {
                console.error('error', e)
            }
        }
    }

    processPageTitleFormat(pageTitleFormat, pageTitle, pageCreatedWhen) {
        let finalTitle = pageTitleFormat

        finalTitle = finalTitle.replace('{{{PageTitle}}}', pageTitle)

        const datePattern = /{{{Date: "(.*?)"}}}/
        const match = finalTitle.match(datePattern)
        if (match) {
            const dateFormat = match[1]
            const formattedDate = moment(pageCreatedWhen).format(dateFormat)
            finalTitle = finalTitle.replace(datePattern, formattedDate)
        }

        return finalTitle.trim()
    }

    async createPageUpdate(
        item,
        pkmType,
        syncDateFormat,
        customTags,
        pageTitleFormat,
    ) {
        const fileName = this.processPageTitleFormat(
            pageTitleFormat,
            item.data.pageTitle,
            item.data.pageCreatedWhen,
        )
        let [pageHeader, annotationsSection] = [null, null]
        let fileContent = ''

        let page
        try {
            page = await this.backendNew.retrievePage(fileName, pkmType)
        } catch (e) {}

        if (page) {
            ;[pageHeader, annotationsSection] = page.split('### Annotations\n')

            if (item.type === 'page') {
                pageHeader = this.extractAndUpdatePageData(
                    pageHeader ||
                        this.pageObjectDefault(
                            item.data.pageTitle,
                            item.data.pageUrl,
                            item.data.pageSpaces || null,
                            item.data.createdWhen,
                            item.data.type,
                            pkmType,
                            syncDateFormat,
                            pageTitleFormat,
                        ),
                    item.data.pageTitle || null,
                    item.data.pageURL || null,
                    item.data.pageSpaces || null,
                    item.data.creationDate || null,
                    item.data.type || null,
                    pkmType,
                    syncDateFormat,
                    customTags,
                    pageTitleFormat,
                )
            } else if (item.type === 'annotation') {
                annotationsSection = this.replaceOrAppendAnnotation(
                    annotationsSection,
                    item,
                    pkmType,
                    syncDateFormat,
                )
            }
        } else {
            let spaces = []
            let spacesString = ''
            if (customTags) {
                customTags.split(',').map((tag) => spaces.push(tag.trim()))
            }

            if (pkmType === 'obsidian') {
                spacesString = spaces
                    .map((space) => ` - "[[${space}]]"\n`)
                    .join('')
            }
            if (pkmType === 'logseq') {
                spacesString = spaces.map((space) => `[[${space}]]`).join(' ')
            }

            pageHeader = this.pageObjectDefault(
                item.data.pageTitle,
                item.data.pageUrl,
                (item.type === 'page' && item.data.spaces) || spacesString,
                item.data.createdWhen,
                item.data.type,
                pkmType,
                syncDateFormat,
                pageTitleFormat,
            )

            if (item.type === 'annotation' || item.type === 'note') {
                annotationsSection = this.annotationObjectDefault(
                    item.data.annotationId,
                    item.data.body
                        ? convertHTMLintoMarkdown(item.data.body)
                        : '',
                    item.data.comment,
                    (item === 'annotation' && item.data.annotationSpaces) ||
                        null,
                    moment(item.data.createdWhen).format(
                        `${syncDateFormat} hh:mma`,
                    ),
                    item.data.type,
                    pkmType,
                    syncDateFormat,
                )
            }
        }

        fileContent =
            pageHeader + '### Annotations\n' + (annotationsSection || '')

        return await this.backendNew.storeObject(fileName, fileContent, pkmType)
    }

    replaceOrAppendAnnotation(
        annotationsSection,
        item,
        pkmType,
        syncDateFormat,
    ) {
        let annotationStartIndex
        let annotationEndIndex
        if (pkmType === 'obsidian' && annotationsSection != null) {
            const annotationStartLine = `<span class="annotationStartLine" id="${item.data.annotationId}"></span>\n`
            const annotationEndLine = `<span class="annotationEndLine" id="${item.data.annotationId}"> --- </span>\n`
            annotationStartIndex = annotationsSection.indexOf(
                annotationStartLine,
            )
            if (annotationStartIndex !== -1) {
                const annotationEndIndex = annotationsSection.indexOf(
                    annotationEndLine,
                    annotationStartIndex,
                )

                const annotationContent = annotationsSection.slice(
                    annotationStartIndex,
                    annotationEndIndex,
                )

                const newAnnotationContent = this.extractAndUpdateAnnotationData(
                    annotationContent,
                    item.data.annotationId,
                    item.data.body,
                    item.data.comment,
                    item.data.annotationSpaces,
                    item.data.createdWhen,
                    item.data.type,
                    pkmType,
                    syncDateFormat,
                )

                return (
                    annotationsSection.slice(0, annotationStartIndex) +
                    newAnnotationContent +
                    annotationsSection.slice(
                        annotationEndIndex + annotationEndLine.length,
                    )
                )
            }
        }
        if (pkmType === 'logseq' && annotationsSection != null) {
            let annotationStartLine = `- <!-- NoteStartLine ${item.data.annotationId} -->---\n`
            const annotationEndLine = ` <!-- NoteEndLine ${item.data.annotationId} -->\n\n`
            annotationStartIndex = annotationsSection.indexOf(
                annotationStartLine,
            )
            annotationEndIndex = annotationsSection.indexOf(annotationEndLine)

            if (annotationEndIndex !== -1 && annotationStartIndex !== -1) {
                const annotationContent = annotationsSection.slice(
                    annotationStartIndex,
                    annotationEndIndex,
                )

                const newAnnotationContent = this.extractAndUpdateAnnotationData(
                    annotationContent,
                    item.data.annotationId,
                    item.data.body,
                    item.data.comment,
                    item.data.annotationSpaces,
                    item.data.createdWhen,
                    item.data.type,
                    pkmType,
                    syncDateFormat,
                )

                return (
                    annotationsSection.slice(0, annotationStartIndex) +
                    newAnnotationContent +
                    annotationsSection.slice(
                        annotationEndIndex + annotationEndLine.length,
                    )
                )
            }
        }

        if (annotationStartIndex === -1 || annotationsSection === null) {
            const newAnnotationContent = this.annotationObjectDefault(
                item.data.annotationId,
                item.data.body ? convertHTMLintoMarkdown(item.data.body) : '',
                item.data.comment,
                item.data.annotationSpaces,
                moment(item.data.createdWhen).format(
                    `${syncDateFormat} hh:mma`,
                ),
                item.data.type,
                pkmType,
                syncDateFormat,
            )
            if (!annotationsSection) {
                return newAnnotationContent
            } else {
                return annotationsSection + newAnnotationContent
            }
        }
    }

    extractAndUpdateAnnotationData(
        annotationContent,
        annotationId,
        body,
        comment,
        annotationSpaces,
        creationDate,
        type,
        pkmType,
        syncDateFormat,
    ) {
        let annotation = annotationContent
        let updatedAnnotation
        let annotationNoteContent = null

        if (pkmType === 'obsidian') {
            // Find and remove the annotation start and end lines from the annotation string
            const annotationStartLine = `<span class="annotationStartLine" id="${annotationId}"></span>\n`
            const annotationEndLine = `<span class="annotationEndLine" id="${annotationId}"> --- </span>\n`
            annotation = annotation.replace(annotationStartLine, '')
            annotation = annotation.replace(annotationEndLine, '')

            // Extract data from the annotation
            let highlightTextMatch
            highlightTextMatch = annotation.match(/> \s*(.+)\n\n/)

            const noteStartString = `<!-- Note -->\n`
            const annotationNoteStartIndex = annotation.indexOf(noteStartString)
            const annotationNoteEndIndex = annotation.indexOf(
                '\n<div id="end"/>\n\r',
            )
            if (
                annotationNoteStartIndex !== -1 &&
                annotationNoteEndIndex !== -1
            ) {
                annotationNoteContent = annotation.slice(
                    annotationNoteStartIndex + noteStartString.length,
                    annotationNoteEndIndex,
                )
            }

            const creationDateMatch = annotation.match(
                /<!-- Created at -->\n(.+)\n/,
            )

            const spacesMatch = annotation.match(/<!-- Spaces -->\n(.+)\n\n/)

            const newHighlightText =
                (highlightTextMatch ? highlightTextMatch[1] : null) || body
            const newHighlightNote =
                comment ||
                (annotationNoteContent ? annotationNoteContent : null)

            const newCreationDate =
                (creationDateMatch ? creationDateMatch[1] : null) ||
                moment(creationDate).format(`${syncDateFormat} hh:mma`)

            const existingSpaces = spacesMatch
                ? spacesMatch[1]
                      .split(', ')
                      .map((space) => space.replace(/\[\[(.+)\]\]/, '$1'))
                : []
            if (annotationSpaces) {
                const index = existingSpaces.indexOf(annotationSpaces)
                if (index !== -1) {
                    existingSpaces.splice(index, 1)
                } else {
                    existingSpaces.push(annotationSpaces)
                }
            }
            const formattedSpaces = existingSpaces
                .map((space) => `[[${space}]]`)
                .join(', ')

            updatedAnnotation = this.annotationObjectDefault(
                annotationId,
                newHighlightText,
                newHighlightNote,
                formattedSpaces,
                newCreationDate,
                type,
                pkmType,
                syncDateFormat,
            )
        }

        if (pkmType === 'logseq') {
            // find content inside annotation string
            let highlightTextMatch = annotation.match(/ - >\s*(.+)\n/)

            const HighlightNoteMatch = annotation.match(
                /  - \*\*Note\*\* \n    - (.+)\n/,
            )
            const creationDateMatch = annotation.match(/Created at:\*\* (.+)\r/)
            const spacesMatch = annotation.match(/  - \*\*Spaces:\*\* (.+)\n/)

            const newHighlightText =
                (highlightTextMatch ? highlightTextMatch[1] : null) || body
            const newHighlightNote =
                comment || (HighlightNoteMatch ? HighlightNoteMatch[1] : null)
            const newCreationDate =
                (creationDateMatch ? creationDateMatch[1] : null) ||
                moment(creationDate).format(`${syncDateFormat} hh:mma`)

            const existingSpaces = spacesMatch
                ? spacesMatch[1]
                      .split(' ')
                      .map((space) => space.replace(/\[\[(.+)\]\]/, '$1'))
                : []

            // replace content
            if (annotationSpaces) {
                const index = existingSpaces.indexOf(annotationSpaces)
                if (index !== -1) {
                    existingSpaces.splice(index, 1)
                } else {
                    existingSpaces.push(annotationSpaces)
                }
            }
            const formattedSpaces = existingSpaces
                .map((space) => `[[${space}]]`)
                .join(' ')

            updatedAnnotation = this.annotationObjectDefault(
                annotationId,
                newHighlightText,
                newHighlightNote,
                formattedSpaces,
                newCreationDate,
                type,
                pkmType,
                syncDateFormat,
            )
        }

        return updatedAnnotation
    }

    extractAndUpdatePageData(
        pageHeader,
        pageTitle,
        pageURL,
        pageSpaces,
        creationDate,
        type,
        pkmType,
        syncDateFormat,
        customTags,
        pageTitleFormat,
    ) {
        let createdWhen = creationDate
        let updatedPageHeader

        if (pkmType === 'obsidian') {
            // Extract data from pageHeader
            const titleMatch = pageHeader.match(/Title: (.+)/)
            const urlMatch = pageHeader.match(/Url: (.+)/)
            const creationDateMatch = pageHeader.match(/Created at: (.+)/)
            const newTitle = (titleMatch ? titleMatch[1] : null) || pageTitle
            const newURL = (urlMatch ? urlMatch[1] : null) || pageURL
            const newCreationDate =
                (creationDateMatch ? creationDateMatch[1] : null) || createdWhen

            let lines = pageHeader.split('\n')
            let spacesStartIndex = lines.findIndex((line) =>
                line.startsWith('Spaces:'),
            )
            let spaces = []

            if (spacesStartIndex !== -1) {
                for (let i = spacesStartIndex + 1; i < lines.length; i++) {
                    let line = lines[i]
                    let match = line.match(/^ - "\[\[(.+)\]\]"$/)
                    if (match) {
                        let content = match[1]
                        spaces.push(content)
                    } else {
                        break // Stop when we reach a line that doesn't match the pattern
                    }
                }
            }

            if (pageSpaces) {
                const index = spaces.indexOf(pageSpaces)
                if (index !== -1) {
                    spaces.splice(index, 1)
                } else {
                    spaces.push(pageSpaces)
                }
            }

            let tagsArray = []
            if (customTags) {
                tagsArray = customTags.split(',')
                let tagsArrayTrimmed = tagsArray.map((tag) => tag.trim())
                tagsArrayTrimmed.forEach((tag) => {
                    if (spaces.indexOf(tag) === -1) {
                        spaces.push(tag)
                    }
                })
            }

            const formattedSpaces = spaces
                .map((space) => ` - "[[${space}]]"\n`)
                .join('')

            updatedPageHeader = this.pageObjectDefault(
                newTitle,
                newURL,
                formattedSpaces,
                newCreationDate,
                type,
                pkmType,
                syncDateFormat,
                pageTitleFormat,
            )
        }
        if (pkmType === 'logseq') {
            // Extract data from pageHeader
            const titleMatch = pageHeader.match(/pagetitle:: (.+)/)
            const urlMatch = pageHeader.match(/pageurl:: (.+)/)
            const creationDateMatch = pageHeader.match(/createdat:: (.+)/)

            // set new values or keep old ones
            const newTitle = (titleMatch ? titleMatch[1] : null) || pageTitle
            const newURL = (urlMatch ? urlMatch[1] : null) || pageURL
            const newCreationDate =
                (creationDateMatch ? creationDateMatch[1] : null) || createdWhen

            // Step 1: Extract content inside [[]] from the line starting with "spaces::" and put them into an array
            let spaces = []
            let spacesLine = pageHeader
                .split('\n')
                .find((line) => line.startsWith('spaces::'))
            if (spacesLine) {
                let spacesMatch = spacesLine.match(/\[\[(.+?)\]\]/g)
                if (spacesMatch) {
                    spaces = spacesMatch.map((space) => space.slice(2, -2))
                }
            }

            // Step 2: Check if "pageSpaces" value is inside this array
            const index = spaces.indexOf(pageSpaces)
            if (index !== -1) {
                // a) If yes, remove it from the spaces array
                spaces.splice(index, 1)
            } else {
                // b) If not, add it to the array
                spaces.push(pageSpaces)
            }

            // Step 3: Create a string with all the items of the spaces array and add back the [[]] around them
            const formattedSpaces = spaces
                .map((space) => `[[${space}]]`)
                .join(' ')

            updatedPageHeader = this.pageObjectDefault(
                newTitle,
                newURL,
                formattedSpaces,
                newCreationDate,
                type,
                pkmType,
                syncDateFormat,
                pageTitleFormat,
            )
        }

        return updatedPageHeader
    }

    pageObjectDefault(
        pageTitle,
        pageURL,
        pageSpaces,
        creationDate,
        type,
        pkmType,
        syncDateFormat,
        pageTitleFormat,
    ) {
        let createdWhen = creationDate
        let titleLine
        let urlLine
        let creationDateLine
        let spacesLine
        let pageSeparator
        let warning = ''
        if (pkmType === 'obsidian' && typeof createdWhen === 'number') {
            createdWhen = `"[[${moment
                .unix(createdWhen / 1000)
                .format(syncDateFormat)}]]"`
        } else if (pkmType === 'logseq' && typeof createdWhen === 'number') {
            createdWhen = `[[${moment
                .unix(createdWhen / 1000)
                .format(syncDateFormat)}]]`
        }

        if (pkmType === 'obsidian') {
            titleLine = `Title: ${pageTitle}\n`
            urlLine = `Url: ${pageURL}\n`
            creationDateLine = `Created at: ${createdWhen}\n`
            spacesLine = pageSpaces ? `Spaces: \n${pageSpaces}` : ''
            pageSeparator = '---\n'
            warning =
                '```\n❗️Do not edit this file or it will create duplicates or override your changes. For feedback, go to memex.garden/chatSupport.\n```\n'
            return (
                pageSeparator +
                titleLine +
                urlLine +
                creationDateLine +
                spacesLine +
                pageSeparator +
                warning
            )
        }
        if (pkmType === 'logseq') {
            urlLine = `pageurl:: ${pageURL}\n`
            titleLine = `pagetitle:: ${pageTitle}\n`
            creationDateLine = `createdat:: ${createdWhen}\n`
            spacesLine = pageSpaces ? `spaces:: ${pageSpaces}\n` : ''
            warning =
                '- ```\n❗️Do not edit this file or it will create duplicates or override your changes. For feedback, go to memex.garden/chatSupport.\n```\n'

            return titleLine + urlLine + creationDateLine + spacesLine + warning
        }
    }

    annotationObjectDefault(
        annotationId,
        body,
        comment,
        annotationSpaces,
        creationDate,
        type,
        pkmType,
        syncDateFormat,
    ) {
        if (pkmType === 'obsidian') {
            const annotationStartLine = `<span class="annotationStartLine" id="${annotationId}"></span>\n`
            let highlightTextLine = body ? `> ${body}\n\n` : ''
            const highlightNoteLine = comment
                ? `<!-- Note -->\n${convertHTMLintoMarkdown(
                      comment,
                  )}\n<div id="end"/>\n\r`
                : ''
            const highlightSpacesLine = annotationSpaces
                ? `<!-- Spaces -->\n${annotationSpaces}\n\n`
                : ''
            const creationDateLine = `<!-- Created at -->\n${creationDate}\n`
            const annotationEndLine = `\r<span class="annotationEndLine" id="${annotationId}"> --- </span>\n`

            return (
                annotationStartLine +
                highlightTextLine +
                highlightNoteLine +
                highlightSpacesLine +
                creationDateLine +
                annotationEndLine
            )
        }
        if (pkmType === 'logseq') {
            let highlightTextLine = ''
            const separatedLine = `- <!-- NoteStartLine ${annotationId} -->---\n`
            highlightTextLine = body ? ` - > ${body}\n` : ''

            const highlightNoteLine = comment
                ? `  - **Note** \n    - ${convertHTMLintoMarkdown(comment)}\n`
                : ''
            const highlightSpacesLine = annotationSpaces
                ? `  - **Spaces:** ${annotationSpaces}\n`
                : ''
            const creationDateLine = `  - **Created at:** ${creationDate}\r`
            const annotationEndLine = ` <!-- NoteEndLine ${annotationId} -->\n\n`
            return (
                separatedLine +
                highlightTextLine +
                highlightNoteLine +
                highlightSpacesLine +
                creationDateLine +
                annotationEndLine
            )
        }
    }
}

function convertHTMLintoMarkdown(html) {
    let turndownService = new TurndownService({
        headingStyle: 'atx',
        hr: '---',
        codeBlockStyle: 'fenced',
    })
    const markdown = turndownService.turndown(html)
    return markdown
}
