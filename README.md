# Buildalon unity-test-summary

A GitHub action to gather and display Unit Tests from the Unity Game Engine in the workflow summary.

Each test run gets a results table, each test case a foldout with its failure message, stack trace and log output, and every failed test an annotation on the file and line Unity reports. Each test run is also posted as a check run on the commit, or on the head commit of a pull request, with its result, summary and failure annotations. Failure locations in files of the repository link to them at that commit. Once a test run's check run is posted, the job summary keeps only its results table and a link to the check run.

Each check run is titled with its counts, such as `1 fail, 2 pass in 6s`, and its summary opens with an aligned counts block. Below the counts, the check run shows each test like the job summary, dropping passing test output and then passing tests when the 65535 character limit is reached.

## How to use

### Workflow

```yaml
permissions:
  contents: read
  checks: write # to post the check runs
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
| `test-results` | The path to the test results file(s). Accepts glob patterns, one per line, with `!` to exclude, to gather the NUnit XML results of several test runs. | true | |
| `github-token` | The token that posts a check run for each test run. It needs `checks: write`. | false | `${{ github.token }}` |
| `check-name` | The name of the check runs, followed by each test results file name. Set it per matrix row so rows do not share check names. | false | `Unity Test Results` |
| `pull-request-comment` | Whether to comment the counts of each test run on the pull request, updating the comment on later runs. It needs `pull-requests: write`. | false | `false` |

The action has no outputs. Without `checks: write`, as on pull requests from forks, the action warns and still writes the job summary and annotations. Annotations for failed tests are made relative to the workspace using `UNITY_PROJECT_PATH`, which [unity-setup](https://github.com/buildalon/unity-setup) sets.

The action runs on Node 24, so self-hosted runners need [actions/runner](https://github.com/actions/runner) v2.327.1 or newer.
