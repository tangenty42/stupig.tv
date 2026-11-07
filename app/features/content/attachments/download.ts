/** Named downloads for attachments rendered in a story body. */
export function useAttachmentDownload() {
  const { content } = useApi()
  return {
    /** A signed URL whose response names the file; the caller performs the browser save. */
    sign: async (story_id: number, file_name: string) => (await content.sign_attachment_download(story_id, file_name)).url,
  }
}
