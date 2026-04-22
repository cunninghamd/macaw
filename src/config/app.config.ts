import * as os from 'os';

const DEFAULT_BASE_PATHS = [`${os.homedir()}/Code`];

export const appConfig = {
  basePaths: process.env.MACAW_BASE_PATHS
    ? process.env.MACAW_BASE_PATHS.split(',').map(p => p.trim())
    : DEFAULT_BASE_PATHS,
};
