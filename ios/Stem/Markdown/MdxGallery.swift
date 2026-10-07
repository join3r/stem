#if DEBUG
import SwiftUI

/// Every MDX fixture (tests/fixtures/mdx) drawn natively, for previews and
/// for simulator screenshots: launch with `-mdxGallery` to open it instead of
/// the app. Interactive components get a submit that only logs, never sends.
struct MdxGallery: View {
    static let samples: [(String, String)] = [
        ("callout", ##"""
Before you wipe the disk, read this.

<Callout type="warn">
This **erases everything** on the drive.

- Back up first
- Double-check the device name
</Callout>

<Callout type="success">
Backups finished at 03:00.
</Callout>

<Callout type="danger">
The key in `config.json` is exposed. Rotate it now.
</Callout>

<Callout>
A callout with no type is an info note.
</Callout>

That's all.
"""##),
        ("chart-line", ##"""
Power dominates the bill and dips in spring.

<Chart type="line" title="Monthly bills" unit="€">
```json
[{"month":"Jan","power":92,"water":31},{"month":"Feb","power":88,"water":29},{"month":"Mar","power":75,"water":30},{"month":"Apr","power":61,"water":28}]
```
</Chart>

<Chart type="donut" title="Where it went">
```json
[{"label":"Rent","value":900},{"label":"Food","value":420},{"label":"Transport","value":120},{"label":"Fun","value":80},{"label":"Gifts","value":40},{"label":"Books","value":30},{"label":"Other stuff","value":20}]
```
</Chart>

<Chart type="bar" title="Visitors by country">
```json
{"columns":["Country","2025","2026"],"rows":[["SK",120,180],["CZ",90,140],["AT",40,52]]}
```
</Chart>
"""##),
        ("code-and-unknown", ##"""
To draw a chart, write this:

````mdx
<Chart type="line" title="Not a chart">
```json
[{"x":"a","y":1}]
```
</Chart>
````

An unknown tag keeps its content:

<Aside>
This is **still shown**, just without the box.
</Aside>

| Name | Value |
| --- | --- |
| a | 1 |
"""##),
        ("collapsible", ##"""
The short answer is yes.

<Collapsible title="Why it works">
The cache keys on the **content hash**, so a renamed file still hits.

> A quote inside, too.
</Collapsible>
"""##),
        ("compare", ##"""
<Compare recommend="SQLite">
```json
[{"name":"SQLite","summary":"A file, zero ops","pros":["Nothing to run","Fast reads"],"cons":["One writer"]},{"name":"Postgres","summary":"A real server","pros":["Many writers"],"cons":["Something to run","Backups"]}]
```
</Compare>

SQLite wins because you have one writer.
"""##),
        ("datatable-wrap", ##"""
<DataTable caption="Témy šité na joinit">
```json
[{"Téma":"Agent má root. Kto má problém?","Čo rozobrať":"Sandboxy, oprávnenia, prompt injection a čo sa stane po meste, keď agent zmaže produkciu."},{"Téma":"Pamäť AI je databáza, nie kúzlo","Čo rozobrať":"Čo ukladať, ako riešiť zabúdanie a dôvodu, prečo embedding nie je pamäť."},{"Téma":"GPU čaká na pamäť","Čo rozobrať":"Bandwidth, KV cache a prečo lokálne modely brzdí pamäť."}]
```
</DataTable>
"""##),
        ("datatable-diagram", ##"""
<DataTable caption="Largest countries">
```json
[{"Country":"Russia","Area (km²)":17098246},{"Country":"Canada","Area (km²)":9984670},{"Country":"China","Area (km²)":9596961}]
```
</DataTable>

<Diagram title="Order flow">
```mermaid
flowchart LR
  App --> Gateway --> Orders --> DB[(Postgres)]
```
</Diagram>
"""##),
        ("form", ##"""
I need a couple of things before planning.

<Form prompt="A few details first" submitLabel="Plan my trip">
<Field name="dates" label="Travel dates" placeholder="e.g. 3–10 May" />
<Field name="budget" label="Budget (€)" type="number" />
<Field name="notes" label="Anything else?" type="textarea" />
</Form>
"""##),
        ("nested", ##"""
Press <Kbd>Cmd</Kbd> and K to search.

<Tabs>
<Tab label="Usage">
<Callout type="info">
Numbers are from **last week**.
</Callout>

<Chart type="stacked" title="Requests" unit="k">
```json
[{"day":"Mon","web":12,"api":30},{"day":"Tue","web":"14","api":"28"}]
```
</Chart>
</Tab>
<Tab label="Raw">
<Collapsible title="Scatter">
<Chart type="scatter" title="Size vs time">
```json
[{"size":1,"ms":12},{"size":2,"ms":19},{"size":4,"ms":41}]
```
</Chart>
</Collapsible>
</Tab>
</Tabs>
"""##),
        ("quiz", ##"""
Let's see what stuck.

<Quiz topic="Capitals">
<Question prompt="Capital of Peru?" answer="Lima">
<Choice>Lima</Choice>
<Choice>Quito</Choice>
<Choice>Bogotá</Choice>
</Question>
<Question prompt="Capital of Slovakia?" answer="Bratislava">
<Choice>Košice</Choice>
<Choice>Bratislava</Choice>
</Question>
</Quiz>
"""##),
        ("replies", ##"""
Your spending is mostly rent and food.

<Replies>
<Reply>Compare with last year</Reply>
<Reply>Where can I cut back?</Reply>
<Reply>Show it by week</Reply>
</Replies>
"""##),
        ("stats", ##"""
<Stats>
```json
[{"label":"Revenue","value":8200,"previous":8900,"unit":"$","trend":[7,8,9,8.2]},{"label":"Churn","value":3.1,"previous":3.8,"unit":"%","good":"down"},{"label":"Uptime","value":"99.98%","delta":"+0.02 pp"},{"label":"Tickets","value":42,"previous":42,"good":"neither"}]
```
</Stats>

Revenue slipped, churn improved.
"""##),
        ("steps-block", ##"""
<Steps>
<Step>

**Open Settings.** Then pick *Server*.

</Step>
<Step>

**Copy the code.**

```bash
stem pair --show
```

</Step>
</Steps>
"""##),
        ("steps", ##"""
Here is how to set it up:

<Steps>
<Step>**Install.** Run `brew install stem`.</Step>
<Step>**Pair.** Scan the code on the desktop.</Step>
<Step>**Chat.** Ask anything.</Step>
</Steps>

Done in three steps.
"""##),
        ("tabs", ##"""
Install it for your platform.

<Tabs>
<Tab label="macOS">
1. Download the dmg
2. Drag Stem to Applications

Then open it.
</Tab>
<Tab label="Linux">
- Install the deb:

```bash
sudo apt install ./stem.deb
```
</Tab>
</Tabs>
"""##),
    ]

    @State private var lastSubmit: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    ForEach(Self.samples, id: \.0) { name, mdx in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(name).font(.caption.monospaced()).foregroundStyle(.tertiary)
                            MarkdownView(mdx)
                        }
                    }
                    if let lastSubmit {
                        Text("Would send:\n\(lastSubmit)").font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                }
                .padding(14)
            }
            .navigationTitle("MDX gallery")
            .navigationBarTitleDisplayMode(.inline)
        }
        .environment(\.mdxActions, MdxActions(submit: { lastSubmit = $0; print("MDX submit:", $0) }, running: false))
        .environment(\.mdxIsLatest, true)
    }
}

#Preview("MDX gallery") { MdxGallery() }
#Preview("MDX gallery, dark") { MdxGallery().preferredColorScheme(.dark) }
#endif
