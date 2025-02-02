# unity-test-summary

A GitHub action to gather and display Unit Tests from the Unity Game Engine.

## How to use

### workflow

```yaml
steps:
  - uses: buildalon/unity-test-summary@v1
  with:
    test-results: 'path/to/test-results/**/*.xml'
```

### inputs

| name | description | required |
| ---- | ----------- | -------- |
| `test-results` | The path to the test results file(s). | true |
