# Memory

← [Stem guide](../../README.md)

With **Memory** on, Stem learns stable, reusable details from ordinary
conversations. You do not need to say “remember this.”

- “My App Source uses pnpm.” in a normal chat may become a **fact** automatically.
- “What did we decide about the Invoices workflow?” can use **Recall**.

Open the right sidebar, choose **Memory**, then choose:

- [**Facts**](facts.md) — durable details Stem can use in later chats.
- [**Recall**](recall.md) — searchable chat history and conversation summaries.

<!-- TODO(screenshot): Recapture with the canonical Maya demo profile. -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../screenshots/memory-facts-dark.png">
    <img alt="The Facts tab in Memory" src="../../screenshots/memory-facts-light.png" width="320">
  </picture>
</p>

Connected folders can also teach Stem facts. **Memorize** allows retention;
**Learn facts** chooses when learning happens. See
[Connected folders](../connected-folders.md).

## Models, and machines that cannot reach the internet

Searching memory by meaning needs two language models, which run inside Stem
— nothing you install, and nothing leaves your computer once they are there. The
first time memory search runs, Stem downloads them (about 640 MB for the default
embedder, Qwen3 Embedding 0.6B, and about 1.2 GB for the Qwen3 reranker that
decides which facts are worth showing) and keeps them in its own folder from then
on. Smaller embedders are one pick away in the same panel if disk is tight; they
measured worse. Under **Memory → Facts → Relevance ranking (advanced)**, the line
under each model says where it is: *Preparing model…*, *Ready · 1024-dim*, or an
error. The **Recall quality** row above that section says whether what you run is
the measured-best setup, and opens the pickers when it is not.

Stem does not ship these models, and it is not a mirror for them: they come from
[Hugging Face](https://huggingface.co), whose terms and licences are between you
and them. On a locked-down work laptop that download is often blocked, and the
line stays on an error.

**Import model files** on that same panel is the way through. Get the model
folder however you can and point Stem at it:

- copy Stem's model folder from a computer where memory search already works
  (`Application Support/Stem/embed-models` on macOS, `%APPDATA%\Stem\embed-models`
  on Windows, `~/.config/Stem/embed-models` on Linux) — a USB stick is fine;
- or download the model from its Hugging Face page, or with
  `huggingface-cli download`, on any machine that can reach it.

Either shape works — Stem finds the model inside the folder you choose and copies
it into place, then loads it. If something is missing it says which file, rather
than failing later with nothing you can act on. Nothing already in Stem's folder
is overwritten.

If Stem runs on [a server](../running-on-a-server.md), the folder has to be on
that machine — copy it there first, and the picker will browse the server's disk
rather than yours.
