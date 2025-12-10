/*
    A Route Loader Module:
    Loads all routes from src/routes folder and bind it with web app.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as _ from 'lodash';

export default function routeBinder(app, express, service) {
  const pathToRoutes = path.join(__dirname, '..', 'routes');
  let routerBind = undefined;
  let moduleName = undefined;
  try {
    fs.readdirSync(pathToRoutes).forEach((file) => {
      if (_.endsWith(file, '.ts')) {
        moduleName = _.replace(file, '.ts', '');

      } else if (_.endsWith(file, '.js')) {
        moduleName = _.replace(file, '.js', '');
      }
      routerBind = require(`./../routes/${moduleName}`); // eslint-disable-line global-require, import/no-dynamic-require
      app.use('/', routerBind.default(app, express, service));
    });
  } catch (err) {
    console.log('log', `Unable to register  route! ${err}`);
  }
}
