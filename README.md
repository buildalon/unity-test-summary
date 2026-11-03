# Buildalon unity-test-summary

A GitHub action to gather and display Unit Tests from the Unity Game Engine in the workflow summary.

Each test run gets a results table, each test case a foldout with its failure message, stack trace and log output, and every failed test an error annotation on the file and line Unity reports.

## How to use

### Workflow

```yaml
steps:
  - uses: buildalon/unity-action@v4
    name: Run Tests
    with:
      build-target: StandaloneLinux64
      log-name: Tests
      args: -runTests -testPlatform EditMode -testResults "${{ github.workspace }}/Logs/EditMode-results.xml"
  - uses: buildalon/unity-test-summary@v2
    if: success() || failure()
    with:
      test-results: ${{ github.workspace }}/Logs/*-results.xml
```

### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `test-results` | The path to the test results file(s). Accepts a [glob pattern](https://github.com/actions/toolkit/tree/main/packages/glob#patterns) to gather the NUnit XML results of several test runs. | true | |

The action has no outputs. Annotations for failed tests are made relative to the workspace using `UNITY_PROJECT_PATH`, which [unity-setup](https://github.com/buildalon/unity-setup) sets.

The action runs on Node 24, so self-hosted runners need [actions/runner](https://github.com/actions/runner) v2.327.1 or newer.
