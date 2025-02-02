import { parseTestResults } from '../src/parser';

describe('tryParseTestResults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should parse StandaloneLinux64-results.xml', async () => {
    const result = await parseTestResults('./tests/StandaloneLinux64-results.xml');
    console.log(JSON.stringify(result, null, 2));
    expect(result).toBeDefined();
    expect(result).toHaveProperty('id');
  });
});