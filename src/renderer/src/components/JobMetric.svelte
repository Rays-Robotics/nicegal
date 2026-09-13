<script lang="ts">
  let { label, value }: { label: string; value: string } = $props();
</script>

<div class="metric">
  <span>{label}</span>
  <span>{value}</span>
</div>

<style>
  .metric {
    display: flex;
    justify-content: space-between;
    gap: var(--space-7);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-tight);
    color: var(--text-primary);
  }

  span:last-child {
    font-variant-numeric: tabular-nums;
  }
</style>
