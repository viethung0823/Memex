import 'core-js'
import { setupScrollReporter } from 'src/activity-logger/content_script'
import { setupPageContentRPC } from 'src/page-analysis/content_script'
import { shouldIncludeSearchInjection } from 'src/search-injection/detection'
import {
    loadAnnotationWhenReady,
    setupRemoteDirectLinkFunction,
} from 'src/direct-linking/content_script'
import { sniffWordpressWorldbrainUser } from 'src/backup-restore/content_script'
import {
    runInBackground,
    makeRemotelyCallableType,
    remoteFunction,
} from 'src/util/webextensionRPC'
import { Resolvable, resolvablePromise } from 'src/util/resolvable'
import { ContentScriptRegistry } from './types'
import { ContentScriptsInterface } from '../background/types'
import { ContentScriptComponent } from '../types'
import { initKeyboardShortcuts } from 'src/in-page-ui/keyboard-shortcuts/content_script'
import { InPageUI } from 'src/in-page-ui/shared-state'
import { InPageUIContentScriptRemoteInterface } from 'src/in-page-ui/content_script/types'
import { RibbonControllerInterface } from 'src/in-page-ui/ribbon/types'
import { SidebarControllerInterface } from 'src/in-page-ui/sidebar/types'
import AnnotationsManager from 'src/annotations/annotations-manager'
import { HighlightInteraction } from 'src/highlighting/ui/highlight-interactions'
import { InPageUIComponent } from 'src/in-page-ui/shared-state/types'

export function main() {
    const controllers: {
        ribbon?: Resolvable<void>
        sidebar?: Resolvable<void>
    } = {}
    async function loadComponent(component: InPageUIComponent) {
        if (!controllers[component]) {
            controllers[component] = resolvablePromise<void>()
            loadContentScript(component)
        }
        return controllers[component]!
    }

    const annotationsManager = new AnnotationsManager()
    const highlighter = new HighlightInteraction()

    const contentScriptRegistry: ContentScriptRegistry = {
        async registerRibbonScript(execute): Promise<void> {
            await execute({
                inPageUI,
                annotationsManager,
                getRemoteFunction: remoteFunction,
                highlighter,
                currentTab: await getCurrentTab(),
            })
            controllers.ribbon!.resolve()
        },
        async registerHighlightingScript(execute): Promise<void> {
            execute()
        },
        async registerSidebarScript(execute): Promise<void> {
            await execute({
                inPageUI,
                annotationsManager,
                getRemoteFunction: remoteFunction,
                highlighter,
                currentTab: await getCurrentTab(),
            })
            controllers.sidebar!.resolve()
        },
        async registerTooltipScript(execute): Promise<void> {
            execute()
        },
    }
    window['contentScriptRegistry'] = contentScriptRegistry

    const inPageUI = new InPageUI({ loadComponent })
    makeRemotelyCallableType<InPageUIContentScriptRemoteInterface>({
        showSidebar: async () => inPageUI.showSidebar(),
    })

    const loadContentScript = createContentScriptLoader()
    if (shouldIncludeSearchInjection(window.location.hostname)) {
        loadContentScript('search_injection')
    }

    setupScrollReporter()
    setupPageContentRPC()
    loadAnnotationWhenReady()
    setupRemoteDirectLinkFunction()
    setupOnDemandInPageUi(() => inPageUI.loadComponent('ribbon'))
    initKeyboardShortcuts(inPageUI)

    // if (window.location.hostname === 'worldbrain.io') {
    //     sniffWordpressWorldbrainUser()
    // }

    // global['worldbrainMemex'] = {
    //     inPageUI,
    //     controllers,
    // }
}

type ContentScriptLoader = (component: ContentScriptComponent) => Promise<void>
export function createContentScriptLoader() {
    const loader: ContentScriptLoader = async (
        component: ContentScriptComponent,
    ) => {
        await runInBackground<
            ContentScriptsInterface<'caller'>
        >().injectContentScriptComponent({
            component,
        })
    }
    return loader
}

export function setupOnDemandInPageUi(loadRibbon: () => void) {
    const listener = (event: MouseEvent) => {
        if (event.clientX > window.innerWidth - 200) {
            loadRibbon()
            document.removeEventListener('mousemove', listener)
        }
    }
    document.addEventListener('mousemove', listener)
}

const getCurrentTab = (() => {
    let currentTab: { id: number; url: string }
    return async () => {
        if (!currentTab) {
            currentTab = await runInBackground<
                ContentScriptsInterface<'caller'>
            >().getCurrentTab()
        }
        return currentTab
    }
})()

main()
