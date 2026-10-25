import { register_content_background } from '@server/services/content/background.service'

export default defineNitroPlugin((app) => {
  register_content_background(app, 'images')
})
