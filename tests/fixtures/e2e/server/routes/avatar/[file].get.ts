import { create_aliyun_oss } from '@server/lib/aliyun-oss'

export default defineEventHandler(async (event) => {
  const object = await create_aliyun_oss().get_object_stream(`avatar/${getRouterParam(event, 'file')}`)
  setHeader(event, 'Content-Type', 'image/jpeg')
  return sendStream(event, object.stream)
})
