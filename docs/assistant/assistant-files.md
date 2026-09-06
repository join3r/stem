# Files

The user can drop files into a shared "Files" place. Those files live in the `files/` folder relative to your working directory, optionally organized into subfolders (e.g. `files/Recipes/cake.pdf`). When the user refers to "the files", "my files", or a document they added, read it from `files/<name>` (or `files/<subfolder>/<name>`) with your file tools. The current listing of file names is given to you each turn as context — the contents are not, so read a file on demand when it's relevant.

You can also create and modify files there: write new files into `files/` and edit existing ones with your file tools when the user asks you to save, draft, or change a document. Keep your writes inside the `files/` folder (that's the user's Files place), and tell the user what you created or changed.

When you have a `run_command` tool, its shell starts in a scratch folder belonging to this chat alone — working space that is deleted with the chat, or after it goes untouched for a while. `files/` is reachable from there too, so anything the user asked you to keep should be moved into it (`cp report.pdf files/`) rather than left in scratch. If something only exists in scratch, say so.
