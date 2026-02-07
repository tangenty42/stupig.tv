<style scoped>
  .bar {
    display: flex;
    flex-direction: row;
    align-items: center;
    position: sticky;
    top: 0;
    left: 0;
    height: 2.5rem;
    padding: .5rem;
    background-color: rgb(from var(--color-border-s) r g b / .9);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-bottom: 1px solid rgb(from var(--color-border-s) r g b / .7);
  }
  .bar:has(.logo:hover) {
    background-color: rgb(from var(--color-border-ss) r g b / .9);
  }
  .bar .logo {
    height: 100%;
    width: 3rem;
    display: grid;
    cursor: pointer;
  }
  .bar .logo > img {
    grid-area: 1 / 1;
    height: 100%;
    display: block;
    object-fit: contain;
  }
  .bar .logo .logo-top {
    z-index: 1;
  }
  .bar .logo .logo-top:hover {
    opacity: .3;
  }
  .bar .title {
    margin-left: 2rem;
    color: var(--color-text-s);
  }
  .bar:has(.logo:hover) .title {
    color: var(--color-theme-d);
  }
  .bar .avatar {
    margin-left: auto;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background-color: var(--color-border-ss);
  }
  .wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    min-height: calc(100vh - 3.5rem);
  }
  .poster {
    width: 100%;
    max-width: 30rem;
    margin-top: 1rem;
  }
  .app {
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: 60rem;
    padding: 1.5rem 1.5rem 0 1.5rem;
    margin-bottom: 5rem;
    box-sizing: border-box;
  }
  .footage {
    font-size: 70%;
    color: var(--color-text-ss);
    margin-bottom: 3rem;
  }
</style>

<template>
  <UApp>
    <div class="bar">
      <div class="logo" @click="go('/')">
        <img class="logo-top" src="/imgs/logo_regular.svg" alt="Stupig logo" />
        <img src="/imgs/logo_fancy.svg" alt="Stupig logo" />
      </div>
      <span class="title">蠢猪小组！</span>
      <img class="avatar" src="/imgs/avatar.svg" alt="User avatar" />
    </div>
    <div class="wrap">
      <img v-if="isHome" class="poster" src="/imgs/告别momomo海报.jpg" alt="告别momomo海报"/>
      <div class="app">
        <NuxtPage />
      </div>
      <div class="footage">
        <p>© 2026 蠢猪小组 All rights reserved.</p>
      </div>
    </div>
  </UApp>
</template>

<script setup>
  const route = useRoute()
  const isHome = computed(() => route.path === '/')
</script>
