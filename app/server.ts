import * as express from 'express';
import * as bodyParser from 'body-parser';
import * as morgan from 'morgan';
import * as dotenv from 'dotenv';
import * as mongoSanitize from 'mongo-sanitize';

import { DbService } from './services/db.service';
import { serviceConfigs } from '../config/global.config';
import routeBinder from './lib/router-binder';
import { FlashcardService } from './services/flashcard.service';
import { UserProgressService } from './services/user-progress.service';
import { StudyService } from './services/study.service';
import { LoggerWrapper } from './services/wrapper/loggerWrapper';

const app = express();
const dbService = new DbService();
let services: any = {};
const loggerWrapper = new LoggerWrapper(`flashcards 1.0`);

// Get environment vars
dotenv.config();

app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(bodyParser.json({
  limit: '8mb'
}));

app.use(sanitizeInput());

app.use(morgan(function (tokens, req: any, res) {
  return [
    req.hostname,
    tokens.method(req, res),
    tokens.url(req, res),
    tokens.status(req, res),
    tokens.res(req, res, 'content-length'), '-',
    tokens['response-time'](req, res), 'ms'
  ].join(' ');
}));

function databaseConnect() {
  console.log('info', 'Attempting to connect to database');
  dbService.connect()
    .then(connectionInfo => {
      console.log('info', `Successfully connected to database!  Connection Info: ${connectionInfo}`);

      bindServices();
      // Binding the routes file with the service file and
      // registering the routes.
      routeBinder(app, express, services);
    }, err => {
      console.log('error', `Unable to connect to database : ${err}`);
    });
}

function bindServices() {
  try {
    const flashcardService = new FlashcardService();
    const userProgressService = new UserProgressService();
    const studyService = new StudyService(flashcardService, userProgressService);

    services = {
      flashcardService,
      userProgressService,
      studyService,
      loggerWrapper
    };
  } catch (err) {
    console.log(`Error occurred binding services : ${err}`);
  }
}

// Start Server: Main point of entry
app.listen(serviceConfigs.port, () => {
  console.log('info', `Service listening on port ${serviceConfigs.port} in ${serviceConfigs.envName}`, {
    timestamp: Date.now()
  });

  // Connect to database
  databaseConnect();
});

process.on('SIGINT', async () => {
  console.log('info', 'exit process');
  if (dbService) {
    await dbService.close();
    console.log('info', 'DB is closed');
    process.exit();
  }
});

function sanitizeInput() {
  return function(req, res, next) {
    ['body', 'params', 'query'].forEach(function(k) {
      if(req[k]) {
        req[k] = mongoSanitize(req[k]);
      }
    });
    next();
  };
}
