import * as mongoose from 'mongoose';
import { connection } from '../../config/connection';
import { DbServiceBase } from './db-service-base';

export class DbService extends DbServiceBase {
  constructor() {
    super(connection, mongoose);
  }
}
