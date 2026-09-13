<script lang="ts">
  import { untrack } from "svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";

  import {
    formatVisualTextTerms,
    parseVisualTextTerms,
    type VisualReferenceTerm,
    type VisualTextTerm,
  } from "../lib/visual-query";
  import NumericStepper from "./NumericStepper.svelte";

  let {
    expression = "",
    references = [],
    onexpressionchange,
    onreferenceschange,
    onchoosefile,
    onaddlibrary,
    onclose,
  }: {
    expression?: string;
    references?: VisualReferenceTerm[];
    onexpressionchange: (expression: string) => void;
    onreferenceschange: (references: VisualReferenceTerm[]) => void;
    onchoosefile: () => void;
    onaddlibrary: () => void;
    onclose: () => void;
  } = $props();

  // The popover is recreated when it closes. Its rows are a deliberately local editing draft,
  // so capture the opening expression once rather than reactively resetting it while a user types.
  const initialExpression = untrack(() => expression);
  let terms = $state<VisualTextTerm[]>(parseVisualTextTerms(initialExpression));
  let lastWrittenExpression = initialExpression;
  let nextId = 0;
  let addMenuOpen = $state(false);
  const exampleCount = $derived(parseVisualTextTerms(expression).length + references.length);

  function formattedExpression(): string {
    return formatVisualTextTerms(terms);
  }

  function sync(): void {
    const nextExpression = formattedExpression();
    lastWrittenExpression = nextExpression;
    onexpressionchange(nextExpression);
  }

  // The main field can be edited while this popover is open. Synchronize only those outside
  // edits; writes made from a row keep their draft and focus instead of remounting on each key.
  $effect(() => {
    if (expression === lastWrittenExpression) return;
    terms = parseVisualTextTerms(expression);
    lastWrittenExpression = expression;
  });

  function addText(): void {
    terms = [...terms, { id: `new-${nextId++}`, text: "", polarity: "more", strength: 1 }];
    addMenuOpen = false;
  }

  function remove(id: string): void {
    terms = terms.filter((term) => term.id !== id);
    sync();
  }

  function update(index: number, changes: Partial<VisualTextTerm>): void {
    terms = terms.map((term, current) => (current === index ? { ...term, ...changes } : term));
    sync();
  }

  function updateReference(index: number, changes: Partial<VisualReferenceTerm>): void {
    onreferenceschange(references.map((reference, current) => current === index ? { ...reference, ...changes } : reference));
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      onclose();
      return;
    }
  }
</script>

<div class="visual-composer" role="dialog" aria-label="Compose visual search" tabindex="-1" onkeydown={keydown}>
  <div class="composer-body">
    <div class="composer-heading">
      <span>Visual search</span>
      {#if expression.trim() || references.length}<span>{exampleCount} example{exampleCount === 1 ? "" : "s"}</span>{/if}
    </div>
    <p>“Less like” changes similarity; it does not guarantee an exclusion.</p>
    <div class="term-list">
      <div class="term-head" aria-hidden="true"><span>Match</span><span>Description</span><span>Weight</span><span></span></div>
      {#each terms as term, index (term.id)}
        <div class="term-row">
          <select
            aria-label="Match direction for {term.text || `example ${index + 1}`}"
            value={term.polarity}
            onchange={(event) => update(index, { polarity: (event.currentTarget as HTMLSelectElement).value as VisualTextTerm["polarity"] })}
          >
            <option value="more">More like</option>
            <option value="less">Less like</option>
          </select>
          <input
            aria-label="Description {index + 1}"
            value={term.text}
            placeholder="Describe an image"
            oninput={(event) => update(index, { text: (event.currentTarget as HTMLInputElement).value })}
          />
          <NumericStepper
            value={term.polarity === "more" ? term.strength : -term.strength}
            label="Weight for {term.text || `example ${index + 1}`}"
            onvaluechange={(weight) =>
              update(index, {
                polarity: weight < 0 ? "less" : "more",
                strength: Math.abs(weight),
              })}
          />
          <button class="remove" type="button" onclick={() => remove(term.id)} aria-label="Remove example {index + 1}">
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      {/each}
      {#each references as reference, index (reference.id)}
        <div class="term-row">
          <select
            aria-label="Match direction for {reference.displayName}"
            value={reference.polarity}
            onchange={(event) => updateReference(index, { polarity: (event.currentTarget as HTMLSelectElement).value as VisualReferenceTerm["polarity"] })}
          ><option value="more">More like</option><option value="less">Less like</option></select>
          <span class="image-reference" title={reference.displayName}>{reference.source === "library" ? "Library photo" : "Chosen file"}: {reference.displayName}</span>
          <NumericStepper
            value={reference.polarity === "more" ? reference.strength : -reference.strength}
            label="Weight for {reference.displayName}"
            onvaluechange={(weight) => updateReference(index, { polarity: weight < 0 ? "less" : "more", strength: Math.abs(weight) })}
          />
          <button class="remove" type="button" onclick={() => onreferenceschange(references.filter((_, current) => current !== index))} aria-label="Remove {reference.displayName}"><X size={13} aria-hidden="true" /></button>
        </div>
      {/each}
    </div>
    <div class="composer-actions">
      <div class="add-menu">
        <button class="ui-button" type="button" aria-haspopup="menu" aria-expanded={addMenuOpen} onclick={() => (addMenuOpen = !addMenuOpen)}><Plus size={13} aria-hidden="true" /> Add <ChevronDown size={11} aria-hidden="true" /></button>
        {#if addMenuOpen}
          <div class="add-menu-popup" role="menu" aria-label="Add visual example">
            <button type="button" role="menuitem" onclick={addText}>Text description</button>
            <button type="button" role="menuitem" onclick={() => { onaddlibrary(); addMenuOpen = false; }}>Selected library photos</button>
            <button type="button" role="menuitem" onclick={() => { onchoosefile(); addMenuOpen = false; }}>Choose file…</button>
          </div>
        {/if}
      </div>
      <span class="external-note">Search updates after you pause typing.</span>
    </div>
  </div>
</div>

<style>
  .visual-composer { position: absolute; z-index: var(--z-popover); top: calc(100% + var(--space-3)); left: 0; width: min(520px, 100%); box-sizing: border-box; border: 1px solid var(--border); background: var(--surface-1); box-shadow: var(--shadow-overlay); color: var(--text-secondary); font-size: var(--font-size-md); }
  .composer-body { display: grid; gap: var(--space-4); padding: var(--space-5); }
  .composer-heading { display: flex; justify-content: space-between; color: var(--text-primary); font-size: var(--font-size-md); font-weight: 600; }
  .composer-heading span:last-child, p { color: var(--text-tertiary); font-weight: normal; }
  p { margin: 0; font-size: var(--font-size-md); }
  .term-list { display: grid; border: 1px solid var(--border); }
  .term-head, .term-row { display: grid; grid-template-columns: 84px minmax(80px, 1fr) 64px 28px; gap: 0; min-width: 0; }
  .term-head { min-height: 18px; align-items: center; border-bottom: 1px solid var(--border); background: var(--surface-1); color: var(--text-tertiary); font-size: var(--font-size-sm); }
  .term-head span { padding: 0 var(--space-3); border-right: 1px solid var(--border-subtle); }
  .term-row + .term-row { border-top: 1px solid var(--border-subtle); }
  select, input { min-width: 0; height: 25px; box-sizing: border-box; padding: 0 var(--space-4); border: 0; border-right: 1px solid var(--border-subtle); border-radius: 0; background: var(--surface-1); color: var(--text-primary); font: inherit; font-size: var(--font-size-md); }
  .image-reference { display: block; min-width: 0; height: 25px; box-sizing: border-box; padding: 4px var(--space-3); overflow: hidden; border-right: 1px solid var(--border-subtle); color: var(--text-primary); text-overflow: ellipsis; white-space: nowrap; }
  .remove { display: inline-grid; width: 100%; height: 25px; place-items: center; border: 0; border-radius: 0; background: transparent; color: var(--text-secondary); }
  .remove:hover { border-color: var(--border); background: var(--surface-hover); color: var(--text-primary); }
  .composer-actions { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
  .composer-actions :global(.ui-button) { display: inline-flex; align-items: center; gap: var(--space-3); }
  .add-menu { position: relative; flex: none; }
  .add-menu-popup { position: absolute; z-index: 1; bottom: calc(100% + var(--space-2)); left: 0; display: grid; min-width: 158px; padding: var(--space-2); border: 1px solid var(--border); background: var(--surface-0); box-shadow: var(--shadow-overlay); }
  .add-menu-popup button { height: 23px; padding: 0 var(--space-4); border: 1px solid transparent; background: transparent; color: var(--text-primary); font: inherit; font-size: var(--font-size-md); text-align: left; }
  .add-menu-popup button:hover { border-color: var(--btn-border-hover); background: var(--surface-hover); }
  .external-note { overflow: hidden; color: var(--text-tertiary); font-size: var(--font-size-md); text-overflow: ellipsis; white-space: nowrap; }
  select:focus-visible, input:focus-visible, .remove:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-ring-offset); }
  @media (max-width: 520px) { .term-head, .term-row { grid-template-columns: 75px minmax(40px, 1fr) 58px 28px; } .external-note { display: none; } }
</style>
