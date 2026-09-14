<script lang="ts">
  import { version } from "../../../../package.json";

  let error = $state<string | null>(null);

  async function openLink(event: MouseEvent & { currentTarget: HTMLAnchorElement }): Promise<void> {
    event.preventDefault();
    error = null;
    try {
      await window.nicegal.native.openExternalUrl(event.currentTarget.href);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function openLicenses(event: MouseEvent): Promise<void> {
    event.preventDefault();
    error = null;
    try {
      await window.nicegal.native.openLicenseInformation();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
</script>

<section class="about-settings" aria-labelledby="about-title">
  <h2 id="about-title">Nicegal <span class="about-version">{version}</span></h2>
  <p>A desktop gallery with local OCR, text and image search.</p>
  <p>Copyright 2026 bep</p>
  <p class="about-links">
    <a href="https://github.com/centuryofimage/nicegal" onclick={openLink}>Frontend source</a>
    <a href="https://github.com/centuryofimage/nicegal-server" onclick={openLink}>Backend source</a>
  </p>
  <p>
    Frontend: <a href="https://opensource.org/license/mit" onclick={openLink}>MIT</a>. Backend:
    <a href="https://www.gnu.org/licenses/agpl-3.0.html" onclick={openLink}>AGPL-3.0-only</a>.
  </p>
  <p><a href="#license-information" onclick={openLicenses}>License information</a></p>
  {#if error}<p class="about-error" role="alert">Could not open link: {error}</p>{/if}
</section>
