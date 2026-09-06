# Plugins

Extension points are named services in a small runtime under `backend/src/plugins/`,
and everything the app ships is loaded through them — a seam only stays honest while
the built-ins use it too.

A plugin is an object with a `name`, an optional `inject` list, and an `apply`:

```js
// my-store.mjs
export default {
  name: 'qdrant-store',
  inject: ['vectorStores'],
  apply: (ctx) => {
    ctx
      .require('vectorStores')
      .register('qdrant', ({ config, embeddings }) => new QdrantStore(config, embeddings), {
        persistent: true,
      });
  },
};
```

```bash
PLUGINS=/abs/path/my-store.mjs VECTOR_STORE=qdrant npm run dev --workspace backend
```

| Service        | Registers                                               | Selected by                                                    |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| `vectorStores` | A vector store kind, plus whether it survives a restart | `VECTOR_STORE` (`auto` keeps the Chroma-then-memory behaviour) |
| `chatModels`   | A chat model kind                                       | `LLM_PROVIDER`                                                 |

Three rules the runtime enforces, and one it does not:

- **`inject` waits.** A plugin naming a service it needs runs when that service
  exists and unloads again if it goes away, so load order is never something an
  outside author has to guess.
- **Two providers for one name is an error.** Silently taking the second means the
  app runs on whichever loaded last, which is a coin toss nobody can see in a log.
- **A name nothing provides stops the app**, listing what does exist. Store
  resolution is lazy, so without that check a typo boots happily and then answers
  every query with nothing.
- **No sandbox.** `PLUGINS` runs third-party code in the backend process, with
  everything that implies. It is opt-in and never discovered by scanning — no
  different in kind from installing an npm package, but worth being explicit about.
