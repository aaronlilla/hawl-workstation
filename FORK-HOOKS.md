# Fork hooks

Edits to Orca's own files, one line each. Hawl code itself lives in `src/hawl/`.

| Piece      | Orca file | Edit | Why                                                                                                                       |
| ---------- | --------- | ---- | ------------------------------------------------------------------------------------------------------------------------- |
| P3-foreman | none yet  | none | `src/hawl/main/foreman` (core, runtime, file storage, IPC registration) imports nothing from Orca and edits no Orca file. |

Hook still to apply (needs the sign-in piece, P2, for the relay link, and Orca's pty daemon for the agent port):
construct `Foreman` + `ForemanRuntime` with `fileStorage(<userData>/hawl/foreman.json)` in the main-process
startup, call `registerForemanIpc(ipcMain, runtime)`, and `runtime.stop()` on quit. Not applied: nothing
can be launched against a relay yet.
