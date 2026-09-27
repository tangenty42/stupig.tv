import { has_permission } from '@shared/permissions'

export default defineNuxtRouteMiddleware(() => {
  const { user } = useAuth()

  if (! has_permission(user.value, 'content_manage', 'full')) {
    return navigateTo('/')
  }
})
