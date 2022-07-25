import ListSharingService from '@worldbrain/memex-common/lib/content-sharing/service/list-sharing'
import type { SharedListReference } from '@worldbrain/memex-common/lib/content-sharing/types'
import { getListShareUrl } from 'src/content-sharing/utils'

export default class ContentSharingService extends ListSharingService {
    protected getKeyLink(params: {
        listReference: SharedListReference
        keyString?: string
    }): string {
        const link = getListShareUrl({
            remoteListId: params.listReference.id as string,
        })

        return params.keyString ? `${link}?key=${params.keyString}` : link
    }

    hasCurrentKey = () => {
        throw new Error('TODO: Implement me')
    }

    processCurrentKey = async () => {
        throw new Error('TODO: Implement me')
    }
}
