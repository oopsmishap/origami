import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

let cachedChartJsSource: string | null = null;

export function getChartJsSource(): string {
  if (cachedChartJsSource) return cachedChartJsSource;

  const req = createRequire(import.meta.url);
  const chartPkg = req.resolve("chart.js");
  const distDir = dirname(chartPkg);
  const umdMin = resolve(distDir, "chart.umd.min.js");
  const umd = resolve(distDir, "chart.umd.js");
  const bundlePath = existsSync(umdMin) ? umdMin : umd;

  if (!existsSync(bundlePath)) {
    throw new Error(
      `Chart.js UMD bundle not found at ${bundlePath}. Ensure chart.js is installed.`
    );
  }

  cachedChartJsSource = readFileSync(bundlePath, "utf8");
  return cachedChartJsSource;
}

/**
 * Returns self-contained script tag embedding Chart.js 4.6.1 and auto-registering
 * required chart components (controllers, scales, elements, plugins) for offline use.
 */
export function getChartJsScriptTag(): string {
  const src = getChartJsSource();
  return `<script>\n${src}\n</script>`;
}
