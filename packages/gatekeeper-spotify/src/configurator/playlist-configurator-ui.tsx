import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  SpotifyPlaylistConfiguratorRpc,
  SpotifyPlaylistConfiguratorValues,
} from "./playlist-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.playlistId === "string" && values.playlistId.length > 0;
  },

  resourceUrl({ values }) {
    return `https://open.spotify.com/playlist/${values.playlistId}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="播放列表" description="搜索你的播放列表，或粘贴 Spotify 播放列表 URL 或链接。">
        <Autocomplete
          name="playlistId"
          value={values.playlistId}
          placeholder="搜索播放列表或粘贴 URL…"
          loadOptions={query => ui.listPlaylists(query)}
          onChange={playlistId => setValues({ playlistId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SpotifyPlaylistConfiguratorRpc, SpotifyPlaylistConfiguratorValues>;
