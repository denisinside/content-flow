<script setup lang="ts">
import ExternalProcessingNotice from './ExternalProcessingNotice.vue'

defineProps<{ email: string; displayName: string | null; csrfToken: string; userId: string }>()
defineEmits<{ 'session-expired': []; back: [] }>()
</script>

<template>
  <section
    id="profile-settings"
    class="profile-settings"
    aria-labelledby="profile-heading"
    tabindex="-1"
  >
    <button
      class="profile-back"
      type="button"
      @click="$emit('back')"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        aria-hidden="true"
      ><path d="m14 6-6 6 6 6M8 12h12" /></svg>
      До роботи
    </button>
    <h1
      id="profile-heading"
      tabindex="-1"
    >
      Налаштування
    </h1>
    <section
      class="profile-section"
      aria-labelledby="profile-account-heading"
    >
      <h2 id="profile-account-heading">
        Профіль
      </h2>
      <dl class="profile-identity">
        <div v-if="displayName">
          <dt>Ім’я</dt><dd>{{ displayName }}</dd>
        </div>
        <div><dt>Електронна пошта</dt><dd>{{ email }}</dd></div>
      </dl>
    </section>
    <section
      class="profile-section profile-session"
      aria-labelledby="profile-session-heading"
    >
      <h2 id="profile-session-heading">
        Сесія
      </h2>
      <slot name="session" />
    </section>
    <ExternalProcessingNotice
      :csrf-token="csrfToken"
      :user-id="userId"
      expanded
      @session-expired="$emit('session-expired')"
    />
  </section>
</template>

<style scoped>
.profile-settings { max-width: 780px; padding-block: 36px 64px; margin-inline: auto; }
.profile-back { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0; background: transparent; border: 0; color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
.profile-back svg { width: 18px; height: 18px; }
.profile-back:hover { color: var(--ink); }
.profile-back:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
h1 { font-family: var(--serif); font-size: 39px; font-weight: 550; line-height: 1.2; letter-spacing: -.025em; margin: 16px 0 40px; }
.profile-section { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 28px; padding-block: 28px; border-top: 1px solid var(--rule); }
h2 { margin: 0; font-family: var(--sans); font-size: 18px; font-weight: 550; }
.profile-identity { margin: 0; display: grid; gap: 20px; font-size: 14px; }
.profile-identity div { display: grid; gap: 6px; }
dt { color: var(--muted); font-size: 13px; }
dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .profile-settings { padding-top: 24px; }
  h1 { font-size: 32px; margin-bottom: 28px; }
  .profile-section { grid-template-columns: 1fr; gap: 20px; }
}
</style>
