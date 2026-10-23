/** Explicit module entry point. Keep implementation imports inside this module. */
export { formatDoctorReport, runDoctor } from './doctor.js';
export { runSetup } from './setup.js';
export { createPrivateHomeFile, getHomeConfigPaths, initializeHomeConfiguration, loadHomeConfiguration, readPrivateHomeFile, shouldLoadHomeConfiguration } from './user-config.js';
