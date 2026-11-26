import { expect, it } from 'vitest'
import { story_rating_image_url, visible_story_labels } from './story-presentation'

it('uses one rating image mapping for ranked stories', () => {
  expect([1, 2, 3, 4, 5].map(rank => story_rating_image_url(path => `/static/${path}`, rank))).toEqual([
    '/static/imgs/ratings/5.svg',
    '/static/imgs/ratings/4.svg',
    '/static/imgs/ratings/3.svg',
    '/static/imgs/ratings/2.svg',
    '/static/imgs/ratings/1.svg',
  ])
})

it('keeps ordinary labels and removes internal labels from display', () => {
  expect(visible_story_labels(['公开标签', '#置顶', '#夯', '另一个标签'])).toEqual(['公开标签', '另一个标签'])
})
