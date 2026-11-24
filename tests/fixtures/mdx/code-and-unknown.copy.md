To draw a chart, write this:

````mdx
<Chart type="line" title="Not a chart">
```json
[{"x":"a","y":1}]
```
</Chart>
````

An unknown tag keeps its content:

This is **still shown**, just without the box.

| Name | Value |
| --- | --- |
| a | 1 |
