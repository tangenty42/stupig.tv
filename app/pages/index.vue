<template>
  <div class="grid grid-cols-1 gap-x-0 lg:gap-x-12 gap-y-4 md:grid-cols-2">
    <div class="home-intro flex min-w-0 flex-col items-stretch">
      <div class="text-7xl lg:mt-12">
        <div class="home-lead text-[45%] lg:text-[55%] text-center text-slate-700 dark:text-slate-300">
          <MySpacedText text="我们是" class="lg:gap-0" />
        </div>
        <div class="home-name font-bold text-[160%] lg:text-[100%] text-slate-800 dark:text-slate-100 mt-12 lg:mt-3 flex flex-col lg:flex-row lg:flex-nowrap items-center justify-center">
          <div class="shrink-0">
            蠢猪
          </div>
          <div class="shrink-0 relative">
            <span>小组</span>
            <span class="text-slate-400/20 dark:text-slate-500/30 absolute bottom-0 ml-2 hidden lg:inline-block">!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!</span>
          </div>
        </div>
      </div>
      <div class="band mt-20 lg:mt-12" :style="{ '--band-mask-url': `url('${static_url('/imgs/good!.svg')}')` }">
        <div class="home-source h-full w-full flex flex-col pt-8 pb-24 text-xl text-slate-600/80 dark:text-slate-400/80">
          <div class="self-center text-[80%] text-slate-600/60 dark:text-slate-400/50 flex items-center gap-2">
            <MySpacedText text="我们来自" />
          </div>
          <div class="home-school self-center mt-4 lg:mt-2">
            <MySpacedText text="广州市西关外国语学校" />
          </div>
          <div class="self-center text-[70%] text-slate-600/70 dark:text-slate-400/60 flex flex-wrap gap-2 items-center justify-center">
            <div><MySpacedText text="2026届" /></div>
            <div><MySpacedText text="高三1班" /></div>
          </div>
          <NuxtLink
            class="home-archive-link link self-center text-[70%] mt-8" to="/content"
            @pointerenter="set_emoji_speed($event, emoji_hover_rate)" @pointerleave="set_emoji_speed($event, emoji_normal_rate)"
          >
            快查看『蠢猪档案』<span aria-hidden="true" class="inline-block w-[1.5em] text-center">{{ archive_emoji }}</span>了解我们
          </NuxtLink>
        </div>
      </div>
    </div>
    <div class="card-x-super-pro-max flex flex-col items-center gap-4">
      <img class="max-w-lg dark:invert" :src="static_url('/imgs/whats_up.svg')" alt="Stupig Chant">
      <NuxtLink class="link" to="/contact">
        联系我们这帮『全能型人才』📞
      </NuxtLink>
      <div class="pt-[200vh] text-xs text-slate-500 dark:text-slate-400">
        蠢人，你在期待什么？
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const static_url = useStaticUrl()

const archive_emoji = useState('home_archive_emoji', () => random_emoji())
const emoji_normal_rate = 1 / 100
const emoji_hover_rate = 1 / 500
const emoji_ease_ms = 1200
let emoji_speed = { from: emoji_normal_rate, to: emoji_normal_rate, started_at: 0 }
let emoji_sampled_at = 0
let emoji_progress = 0
let emoji_timer: ReturnType<typeof setTimeout> | undefined

function emoji_rate_at(now: number) {
  const progress = Math.min(1, (now - emoji_speed.started_at) / emoji_ease_ms)
  const eased = progress * progress * (3 - 2 * progress)
  return emoji_speed.from + (emoji_speed.to - emoji_speed.from) * eased
}

function advance_emoji(now: number) {
  const rate = emoji_rate_at(now)
  // Keep the fraction already elapsed toward the next swap when the pointer moves.
  const average_rate = (rate + emoji_rate_at(emoji_sampled_at)) / 2
  emoji_progress += (now - emoji_sampled_at) * average_rate
  emoji_sampled_at = now
  if (emoji_progress >= 1) {
    emoji_progress %= 1
    archive_emoji.value = random_emoji()
  }
  return rate
}

function schedule_emoji(now: number, rate: number) {
  const remaining = (1 - emoji_progress) / rate
  const easing = emoji_speed.from !== emoji_speed.to && now - emoji_speed.started_at < emoji_ease_ms
  const delay = easing ? Math.min(remaining, 25) : remaining
  emoji_timer = setTimeout(() => {
    const now = performance.now()
    schedule_emoji(now, advance_emoji(now))
  }, Math.max(1, Math.ceil(delay)))
}

function set_emoji_speed(event: PointerEvent, target: number) {
  if (event.pointerType === 'touch' || target === emoji_speed.to)
    return

  const now = performance.now()
  const rate = advance_emoji(now)
  emoji_speed = { from: rate, to: target, started_at: now }
  clearTimeout(emoji_timer)
  schedule_emoji(now, rate)
}

onMounted(() => {
  emoji_sampled_at = performance.now()
  schedule_emoji(emoji_sampled_at, emoji_normal_rate)
})
onUnmounted(() => clearTimeout(emoji_timer))
</script>

<style scoped>
  .band {
    position: relative;
  }
  .band::before {
    @apply content-[''] absolute inset-y-0 -left-[100vw] w-[200vw] -z-[233]
      bg-gradient-to-t from-blue-400/10 dark:from-gray-500/5 to-transparent to-80%;
    mask: var(--band-mask-url);
    mask-repeat: repeat-x;
    mask-position: center;
  }

  @media (max-width: 47.999rem), (max-width: 63.999rem) and (max-height: 31rem) {
    .home-intro {
      --home-viewport-height: 100vh;
      --home-space: clamp(.625rem, calc((var(--home-viewport-height) - 29rem) * .1), 2rem);
    }

    @supports (height: 100svh) {
      .home-intro {
        --home-viewport-height: 100svh;
      }
    }

    .home-lead {
      font-size: clamp(1.125rem, calc(var(--home-viewport-height) * .042), 2.025rem);
    }

    .home-name {
      font-size: clamp(3.25rem, min(28vw, calc(var(--home-viewport-height) * .15)), 7.2rem);
      margin-top: calc(1.5 * var(--home-space));
    }

    .band {
      margin-top: calc(2.5 * var(--home-space));
    }

    .home-source {
      font-size: clamp(.9375rem, min(4.7vw, calc(var(--home-viewport-height) * .027)), 1.25rem);
      line-height: 1.4;
      padding-top: var(--home-space);
      padding-bottom: clamp(1.25rem, calc(var(--home-viewport-height) * .1), 6rem);
    }

    .home-school {
      margin-top: calc(.5 * var(--home-space));
    }

    .home-archive-link {
      font-size: max(.875rem, 70%);
      margin-top: var(--home-space);
    }
  }

  @media (max-width: 63.999rem) and (max-height: 31rem) and (orientation: landscape) {
    .home-intro {
      margin-top: -2.5rem;
    }

    .home-name {
      flex-direction: row;
    }
  }

  .card-x-super-pro-max {
    @apply bg-transparent md:px-8 pb-12 pt-16 md:pt-6 md:-mt-12 md:shadow-lg md:backdrop-blur-[6px];
  }
  .dark .card-x-super-pro-max {
    @apply md:shadow-2xl md:shadow-gray-400/20;
  }
</style>
