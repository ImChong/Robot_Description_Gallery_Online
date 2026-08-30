#!/usr/bin/env node
/** Browser check for the public-GitHub-URL half of the custom URDF picker. */
import { launchBrowser } from './browser.mjs';

const base = process.env.BASE_URL || 'http://localhost:8080';
const blobUrl = 'https://github.com/demo/robot/blob/main/urdf/tiny.urdf';
const rawUrl = 'https://raw.githubusercontent.com/demo/robot/main/urdf/tiny.urdf';
const urdf = `<?xml version="1.0"?>
<robot name="github_tiny">
  <link name="base">
    <visual><geometry><box size="0.4 0.2 0.1"/></geometry></visual>
    <collision><geometry><box size="0.4 0.2 0.1"/></geometry></collision>
    <inertial>
      <mass value="1"/>
      <inertia ixx="0.01" ixy="0" ixz="0" iyy="0.02" iyz="0" izz="0.03"/>
    </inertial>
  </link>
</robot>`;

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route(rawUrl, (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/xml',
    headers: { 'access-control-allow-origin': '*' },
    body: urdf,
  }),
);

await page.goto(`${base}/web/`, { waitUntil: 'networkidle' });
await page.locator('#custom-open').click();
await page.locator('#custom-github-url').fill(blobUrl);
await page.locator('#custom-github-form').evaluate((form) => form.requestSubmit());
await page.locator('#custom-go:not([disabled])').waitFor();

const report = await page.locator('#custom-report').textContent();
if (!report.includes('github_tiny') || !report.includes('demo/robot')) {
  throw new Error(`GitHub source was not analysed: ${report}`);
}

await page.locator('#custom-go').click();
await page.waitForFunction(
  () => document.querySelector('.stage')?.dataset.loaded === '__local__',
  null,
  { timeout: 30000 },
);
const result = await page.evaluate(() => ({
  name: document.getElementById('d-name').textContent.trim(),
  source: document.getElementById('d-sub').textContent.trim(),
  localBadgeHidden: document.getElementById('d-local-badge').hidden,
  resourcesHidden: document.getElementById('panel-resources').hidden,
}));
await browser.close();

if (result.name !== 'github_tiny') throw new Error(`wrong model name: ${result.name}`);
if (!result.source.includes('demo/robot')) throw new Error(`wrong source: ${result.source}`);
if (!result.localBadgeHidden) throw new Error('GitHub model was labelled as a local file');
if (result.resourcesHidden) throw new Error('GitHub resources panel is hidden');
console.log('✓ pasted GitHub URDF loaded and rendered');
