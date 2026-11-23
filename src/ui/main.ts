// 入口:装配页面。

import { App } from './app.js';
import { initHeader, initZonesPanel, initMonitorPanel, initGainPanel, initLogPanel }
  from './panels.js';

const app = new App();

initHeader(app, document.getElementById('header-controls')!);
initZonesPanel(app, document.getElementById('panel-zones')!);
initMonitorPanel(app, document.getElementById('panel-monitor')!);
initGainPanel(app, document.getElementById('panel-gain')!);
initLogPanel(app, document.getElementById('panel-log')!);
