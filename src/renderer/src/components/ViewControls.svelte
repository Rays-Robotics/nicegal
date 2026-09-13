<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import FileStack from "@lucide/svelte/icons/file-stack";
  import Grid3X3 from "@lucide/svelte/icons/grid-3x3";
  import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
  import Rows3 from "@lucide/svelte/icons/rows-3";

  import type { Timeline } from "../../../shared/backend";
  import type { DividerGranularity, LayoutMode } from "../lib/gallery/types";

  import { popoverDismiss } from "../lib/popover-dismiss";

  let {
    layoutMode = $bindable(),
    sortField = $bindable(),
    dateHeaders = $bindable(),
    ranked = false,
  }: {
    layoutMode: LayoutMode;
    sortField: Timeline;
    dateHeaders: DividerGranularity;
    ranked?: boolean;
  } = $props();

  type OpenMenu = "organize" | "view" | null;
  type LayoutOption = {
    value: LayoutMode;
    label: string;
    title: string;
    icon: typeof Rows3;
  };

  const layoutOptions: readonly LayoutOption[] = [
    {
      value: "justified",
      label: "Justified layout",
      title: "Justified layout — image rows with a shared height",
      icon: Rows3,
    },
    {
      value: "masonry",
      label: "Masonry layout",
      title: "Masonry layout — variable-height image columns",
      icon: LayoutDashboard,
    },
    {
      value: "grid",
      label: "Grid layout",
      title: "Grid layout — uniform image cells",
      icon: Grid3X3,
    },
  ];
  const headerOptions: readonly { value: DividerGranularity; label: string }[] = [
    { value: "none", label: "None" },
    { value: "day", label: "Day" },
    { value: "month", label: "Month" },
  ];

  let openMenu = $state<OpenMenu>(null);

  const sortLabel = $derived(sortField === "modified" ? "file date" : "photo date");
  const headerLabel = $derived(dateHeaders === "none" ? "none" : `date headers by ${dateHeaders}`);
  const organizeLabel = $derived(
    ranked
      ? "Organize gallery: relevance order, date headers hidden"
      : `Organize gallery: ${sortLabel}, ${headerLabel}`,
  );

  function toggleMenu(menu: Exclude<OpenMenu, null>): void {
    openMenu = openMenu === menu ? null : menu;
  }

  function chooseLayout(mode: LayoutMode): void {
    layoutMode = mode;
    openMenu = null;
  }

  function chooseSort(field: Timeline): void {
    sortField = field;
  }

  function chooseHeaders(granularity: DividerGranularity): void {
    dateHeaders = granularity;
  }
</script>

{#snippet layoutChoices(menu = false)}
  <div
    class={[menu && "menu-choices", !menu && "app-toolbar-group"]}
    role="radiogroup"
    aria-label="Gallery layout"
  >
    {#each layoutOptions as option (option.value)}
      <button
        class={[layoutMode === option.value && "selected", !menu && "app-toolbar-button"]}
        type="button"
        role="radio"
        aria-checked={layoutMode === option.value}
        aria-label={option.label}
        title={option.title}
        onclick={() => chooseLayout(option.value)}
      >
        <option.icon size={16} strokeWidth={1.75} aria-hidden="true" />
        {#if menu}<span>{option.label}</span>{/if}
      </button>
    {/each}
  </div>
{/snippet}

{#snippet organizationChoices()}
  <div class="organization-menu" aria-label="Organize gallery">
    <h2>Organize</h2>
    {#if ranked}<p>Date options apply when sorting by Date.</p>{/if}
    <div class="menu-rule" role="separator"></div>
    <div class="organization-group" role="radiogroup" aria-label="Sort by">
      <h3>Sort by</h3>
      <div class="choice-row">
        <button
          type="button"
          role="radio"
          aria-checked={sortField === "modified"}
          disabled={ranked}
          onclick={() => chooseSort("modified")}
        >
          <span class="choice-mark" aria-hidden="true"
            >{#if sortField === "modified"}<Check size={12} />{/if}</span
          >File date
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={sortField === "capture"}
          disabled={ranked}
          onclick={() => chooseSort("capture")}
        >
          <span class="choice-mark" aria-hidden="true"
            >{#if sortField === "capture"}<Check size={12} />{/if}</span
          >Photo date
        </button>
      </div>
    </div>
    <div class="organization-group" role="radiogroup" aria-label="Date headers">
      <h3>Date headers</h3>
      <div class="choice-row">
        {#each headerOptions as option (option.value)}
          <button
            type="button"
            role="radio"
            aria-checked={dateHeaders === option.value}
            disabled={ranked}
            onclick={() => chooseHeaders(option.value)}
          >
            <span class="choice-mark" aria-hidden="true"
              >{#if dateHeaders === option.value}<Check size={12} />{/if}</span
            >{option.label}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/snippet}

<div class="view-controls" {@attach popoverDismiss(openMenu !== null, () => (openMenu = null))}>
  <div class="expanded-controls">
    {@render layoutChoices()}
    <div class="app-toolbar-divider" role="separator"></div>
    <div class="organize-control">
      <button
        class={[
          "app-toolbar-button",
          "app-toolbar-text-button",
          openMenu === "organize" && "selected",
        ]}
        type="button"
        aria-label={organizeLabel}
        aria-haspopup="dialog"
        aria-expanded={openMenu === "organize"}
        title="Organize gallery"
        onclick={() => toggleMenu("organize")}
      >
        <FileStack size={13} strokeWidth={1.75} aria-hidden="true" />
        <span>Organize</span>
      </button>
      {#if openMenu === "organize"}
        <div class="view-menu organize-popup" role="dialog" aria-label="Organize gallery">
          {@render organizationChoices()}
        </div>
      {/if}
    </div>
  </div>

  <div class="collapsed-control">
    <button
      class={["app-toolbar-button", "app-toolbar-text-button", openMenu === "view" && "selected"]}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={openMenu === "view"}
      onclick={() => toggleMenu("view")}
    >
      View <ChevronDown size={13} aria-hidden="true" />
    </button>
    {#if openMenu === "view"}
      <div class="view-menu collapsed-popup" role="dialog" aria-label="View options">
        <section>
          <h2>Layout</h2>
          {@render layoutChoices(true)}
        </section>
        <div class="menu-rule" role="separator"></div>
        {@render organizationChoices()}
      </div>
    {/if}
  </div>
</div>

<style>
  .view-controls,
  .expanded-controls,
  .choice-row {
    display: flex;
    align-items: center;
  }

  .view-controls {
    position: relative;
    flex: none;
    align-self: flex-start;
    height: var(--toolbar-control-height);
  }

  .expanded-controls {
    height: 100%;
    gap: var(--space-6);
  }

  .organization-menu button:focus-visible,
  .menu-choices button:focus-visible {
    position: relative;
    z-index: var(--z-raised);
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .organize-control,
  .collapsed-control {
    position: relative;
    height: 100%;
  }

  .collapsed-control {
    display: none;
  }

  .view-menu {
    position: absolute;
    z-index: var(--z-popover);
    top: calc(100% + var(--space-2));
    display: grid;
    min-width: max-content;
    padding: var(--space-6);
    border: 1px solid var(--border);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }

  .organize-popup {
    right: 0;
  }

  .collapsed-popup {
    right: 0;
    gap: var(--space-6);
  }

  .view-menu h2,
  .view-menu h3 {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
  }

  .view-menu h2 {
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }

  .view-menu section {
    display: grid;
    gap: var(--space-4);
  }

  .organization-group {
    display: grid;
    gap: var(--space-4);
  }

  .menu-rule {
    height: 1px;
    margin: 0 calc(var(--space-6) * -1);
    background: var(--border-subtle);
  }

  .organization-menu {
    display: grid;
    min-width: 220px;
    gap: var(--space-6);
  }

  .organization-menu p {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }

  .organization-menu button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .organization-menu .menu-rule {
    margin: 0;
  }

  .choice-row {
    gap: var(--space-4);
  }

  .organization-menu button,
  .menu-choices button {
    display: inline-flex;
    min-height: 22px;
    align-items: center;
    border: 1px solid var(--btn-border);
    border-radius: var(--radius-sm);
    background: var(--btn-face);
    box-shadow: var(--bevel-raised);
    color: var(--text-secondary);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .organization-menu button {
    padding: 0 var(--space-4) 0 var(--space-2);
  }

  .organization-menu button:hover,
  .menu-choices button:hover {
    border-color: var(--btn-border-hover);
    background: var(--btn-face-hover);
    color: var(--text-primary);
  }

  .organization-menu button[aria-checked="true"] {
    border-color: var(--btn-border-active);
    background: var(--btn-face-active);
    box-shadow: var(--bevel-sunken);
    color: var(--text-primary);
  }

  .choice-mark {
    display: inline-flex;
    width: 13px;
    justify-content: center;
    color: var(--accent-active);
  }

  .menu-choices {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-3);
  }

  .menu-choices button {
    justify-content: center;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-6);
  }

  .menu-choices button.selected {
    border-color: var(--btn-border-active);
    background: var(--btn-face-active);
    box-shadow: var(--bevel-sunken);
    color: var(--text-primary);
  }

  @media (max-width: 720px) {
    .expanded-controls {
      display: none;
    }

    .collapsed-control {
      display: block;
    }
  }
</style>
