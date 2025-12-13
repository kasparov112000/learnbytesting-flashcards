import * as path from 'path';
import { ConnectionConfig } from '../app/services/configuration/connection-config';

const environment = process.env.ENV_NAME || 'LOCAL';
let database = process.env.MONGO_NAME || 'mdr-flashcards';

const host = process.env.MONGO_HOST || '127.0.0.1';
const mongoport = process.env.MONGO_PORT || 27017;
const password = process.env.MONGO_PASSWORD || '';
const username = process.env.MONGO_USER || '';
const ssl = process.env.MONGO_SSL || false;
const credentials = username ? `${username}:${encodeURIComponent(password)}@` : '';
const poolSize = process.env.MONGO_POOL_SIZE ? parseInt(process.env.MONGO_POOL_SIZE, 10) : 100;

const connection = new ConnectionConfig({
  env: environment,
  host: host,
  modelName: 'Flashcard',
  schemaPath: path.join(__dirname, '..', 'app', 'models'),
  dbUrl: (process.env.ENV_NAME || 'LOCAL') !== 'LOCAL' ?
    `mongodb+srv://${credentials}${host}/${database}?retryWrites=true` :
    `mongodb://${credentials}${host}:${mongoport}/${database}?ssl=${ssl}`,
    options: {
    poolSize: poolSize,
    useNewUrlParser: true,
    useUnifiedTopology: true
  },
});

export { connection };
