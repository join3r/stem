# Skills

← [Stem guide](../../README.md) · [Tools](README.md)

Examples only. These skills are not bundled with Stem.

| Example skill | Reusable procedure |
| --- | --- |
| `food-ordering` | Rebuild a usual order; verify items, address, and total; stop before checkout |
| `agent-browser-vercel` | Smoke-test a Vercel deployment with an existing agent-browser setup |
| `monthly-invoice-report` | Reconcile invoice data; total the month; flag missing or overdue invoices |
| `standup-meeting-report` | Turn standup notes into completed work, next steps, owners, and blockers |

Skills are reusable procedures: when to use a workflow, its steps, and how to verify
the result. Not memories. They provide no accounts, tools, or permissions by
themselves.

Open **Tools → Skills**.

<!-- TODO(screenshot): Skills list showing the four demo skills, an auto label, usage details, and enabled switches. -->

## What you can do

- Use the switch to disable a skill without deleting it.
- Click a skill to select it, then the trash button under the list deletes it for
  good — it asks first. This works on skills you wrote yourself too: on a server
  install the skills folder is on the server, so this is the only way to reach it.
- **Tidy up** merges duplicate auto skills and archives ones untouched for 90 days.
  Archiving is the same reversible switch as above, so an archived skill can be
  switched back on.
- **Saving skills** decides how much Stem may save on its own. Asking it to save
  one always works, whichever you pick.
- **Skills model** does the model-driven skills work: writing, `/learn`, tidy-up.

An **auto** label marks a skill Stem created. Usage details show whether it is still
useful. Stem may create, change, or remove auto skills without an approval card.
Skills you add yourself are left unchanged.

A cloud curator receives relevant chat excerpts during collection and auto-skill text
during upkeep. It may use provider quota.

Keep skills narrow and verifiable. Disable an auto skill to stop Stem using it.

## Skills and the machine they run on

A skill is followed later, possibly somewhere else: your library travels with Stem when you
move it to a server, and a step that worked on your own Mac may then run on a machine that
cannot reach the same files, the same home network, or the same sites. Stem is told which
machine it is on when it writes a skill, and a procedure that depends on one is written down
with the machine, the reason, and the way in — `run_command`'s `device` parameter, or an MCP
server pinned to that computer. If a skill you wrote by hand needs a particular machine, say
so in its steps for the same reason.
