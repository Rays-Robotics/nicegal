<script lang="ts">
  import { onMount } from "svelte";

  import GalleryView from "./GalleryView.svelte";
  import { createApplication, provideApplication } from "./lib/application.svelte";

  const application = createApplication();
  provideApplication(application);

  onMount(() => application.start());
</script>

<GalleryView />
