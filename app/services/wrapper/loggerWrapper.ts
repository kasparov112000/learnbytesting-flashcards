import axios from 'axios';
import { microservices } from '../../../config/global.config';

export class LoggerWrapper {
    private _servicename = '';
    private logLevel = {
      fatal: 'fatal',
      error: 'error',
      info: 'info',
      debug: 'debug'
    };

    constructor(serviceName: string) {
      this._servicename = serviceName;
    }

    public fatal(component: string, message: any, correlationId: string) {
      this.sendToLogs(component, this.logLevel.fatal, message, correlationId);
    }

    public error(component: string, message: any, correlationId: string) {
      this.sendToLogs(component, this.logLevel.error, message, correlationId);
    }

    public info(component: string, message: any, correlationId: string) {
      this.sendToLogs(component, this.logLevel.info, message, correlationId);
    }

    public debug(component: string, message: any, correlationId: string) {
      this.sendToLogs(component, this.logLevel.debug, message, correlationId);
    }

    private async sendToLogs(component: string, logLevel: string, message: any, correlationId: string) {
      const corId = correlationId || 'NO CORRELATION ID';

      const body = {
        component: `${this._servicename}::${component}`,
        loglevel: logLevel,
        message: message,
        correlationId: corId
      }

      const headers = {
        'x-correlation-id': corId
      }

      const url = microservices.logger.getFullURL();

      const response = await axios({
        url,
        method: 'POST',
        data: body,
        headers: headers
      }).catch((err) => {
        console.log(err);
      });

      return response;
    }
}
