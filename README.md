<p align="center">
  <img alt="A Blurry W" src="./dissociating-wiki-logo.png" class="logo" />
</p>

# Dissociating Wikipedia Bot

A [bot](https://bsky.app/profile/dissociating-wiki.bsky.social) to post Wikipedia links with mistaken preview images.

Inspired by a bug on my phone where the Wikipedia app loads the preview image from last article I read.

## Setup

```sh
npm install
cp .env.example .env   # then fill it in
```

## Running

```sh
npm run dry    # prints the pairing, posts nothing
npm run post   # actually posts
```

### `--order`

Controls which trending topic gets picked.

| Value                | Behaviour                                                               |
| -------------------- | ----------------------------------------------------------------------- |
| `random` _(default)_ | Shuffles both the topics and the extracted candidates within each topic |
| `trending`           | Keeps Bluesky's ranking and Claude's candidate ranking                  |

```sh
npm run dry -- --order trending
npm run post -- --order=random
```
