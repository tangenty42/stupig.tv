import { has_permission } from '@shared/permissions'

export default defineNuxtRouteMiddleware(() => {
  const { user } = useAuth()

  if (! has_permission(user.value, 'admin_access', 'readonly')) {
    return navigateTo('/')
  }
})
