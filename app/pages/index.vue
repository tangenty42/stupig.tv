<template>
  <div class="grid grid-cols-1 gap-x-0 lg:gap-x-24 gap-y-4 md:grid-cols-2">
    <div class="flex flex-col items-stretch">
      <div class="text-7xl lg:mt-12">
        <div class="text-[45%] lg:text-[55%] text-center lg:text-end text-slate-700 dark:text-slate-300">
          <MySpacedText text="我们是" class="lg:gap-0" />
        </div>
        <div class="font-bold text-[160%] lg:text-[100%] text-slate-800 dark:text-slate-100 mt-12 lg:mt-3 flex flex-col lg:flex-row lg:flex-nowrap items-center justify-center lg:justify-end">
          <div class="shrink-0">
            蠢猪
          </div>
          <div class="shrink-0 relative">
            <span>小组</span>
            <span class="absolute bottom-0 ml-2 hidden lg:inline-block">!</span>
          </div>
        </div>
      </div>
      <div class="band mt-20 lg:mt-12" :style="{ '--band-mask-url': `url('${static_url('/imgs/good!.svg')}')` }">
        <div class="h-full w-full flex flex-col pt-8 pb-24 text-xl text-slate-600/80 dark:text-slate-400/80">
          <div class="self-center lg:self-end text-[80%] text-slate-600/60 dark:text-slate-400/50 flex items-center gap-2">
            <MySpacedText text="我们来自" />
          </div>
          <div class="self-center lg:self-end mt-4 lg:mt-2">
            <MySpacedText text="广州市西关外国语学校" />
          </div>
          <div class="self-center lg:self-end text-[70%] text-slate-600/70 dark:text-slate-400/60 flex flex-wrap gap-2 items-center justify-center">
            <div><MySpacedText text="2026届" /></div>
            <div><MySpacedText text="高三1班" /></div>
          </div>
          <NuxtLink class="link self-center lg:self-end text-[70%] mt-8" to="/contact">
            联系我们这帮「全能型人才」
          </NuxtLink>
        </div>
      </div>
    </div>
    <div class="card-x-super-pro-max flex flex-col items-center gap-4">
      <img class="max-w-lg dark:invert" :src="static_url('/imgs/whats_up.svg')" alt="Stupig Chant">
      <NuxtLink class="link" to="/content">
        查看「蠢猪档案」，了解我们
      </NuxtLink>
      <div class="pt-[200vh] text-xs text-slate-500 dark:text-slate-400">
        蠢人，你在期待什么？
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const static_url = useStaticUrl()
</script>

<style scoped>
  .band {
    position: relative;
  }
  .band::before {
    @apply content-[''] absolute inset-y-0 -left-[100vw] w-[200vw] -z-[233]
      bg-gradient-to-t from-blue-400/15 dark:from-gray-500/10 to-transparent to-80%;
    mask: var(--band-mask-url);
    mask-repeat: repeat-x;
    mask-position: center;
  }

  .card-x-super-pro-max {
    @apply bg-transparent md:px-8 pb-12 pt-16 md:pt-6 md:-mt-12 md:shadow-lg md:backdrop-blur-[6px];
  }
  .dark .card-x-super-pro-max {
    @apply md:shadow-2xl md:shadow-gray-400/20;
  }
</style>
