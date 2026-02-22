<template>
  <div class="container mx-auto grid grid-cols-1 lg:grid-cols-2 gap-x-24 gap-y-4 px-4 pt-12">
    <div class="grow flex flex-col items-stretch gap-4">
      <h1 class="text-left">
        欢迎来到
        <br />
        蠢猪小组 官网！
      </h1>
      <h2 class="band relative py-12 flex flex-col mt-6 sm:mt-16 md:*:text-4xl/14">
        <span class="self-start font-normal">
          我们来自
        </span>
        <span class="self-end">广州市西关外国语学校</span>
        <span class="self-end">
          <span class="font-normal">现役</span>
          高三 1 班
          <UIcon class="align-middle" name="twemoji:pig-face" />
        </span>
      </h2>
    </div>
    <div class="grow flex flex-col items-center gap-4 bg-default py-12 band-x-super-pro-max">
      <img class="max-w-120 dark:invert " src="/imgs/whats_up.svg" alt="Stupig Chant" />
      <ULink class="font-bold mt-16" to="/contact">联系我们这帮“全能型人才”</ULink>
    </div>
  </div>
</template>

<style scoped>
  @reference '@/assets/css/global.css';

  .band > * {
    @apply bg-default/25 backdrop-blur-[2px] shadow-xl px-2;
    @variant lg {
      @apply px-4;
    }
    @variant dark {
      @apply shadow-gray-400/50;
    }
  }
  .band::before {
    @apply content-[''] absolute inset-y-0 -left-[100vw] w-[200vw] -z-233
      bg-blue-300/20 mask-[url('/imgs/good!.svg')] mask-repeat-x mask-center;
  }
  .dark .band::before {
    @apply bg-gray-500/20;
  }

  .band-x-super-pro-max {
    @variant lg {
      @apply bg-default/50 backdrop-blur-[2px] border-l border-t border-r border-pink-200;
    }
  }
  .dark .band-x-super-pro-max {
    @variant lg {
      @apply border-gray-700;
    }
  }
</style>
