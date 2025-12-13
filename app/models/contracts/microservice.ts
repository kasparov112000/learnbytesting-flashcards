export class MicroserviceConnection {
  public url: string;
  public port: number;
  public servicename: string;
  public endpoints: {};

  constructor(url: string, port: number, servicename: string, endpoints?: {}) {
    this.url = (process.env.ENV_NAME || 'LOCAL') !== 'LOCAL' ? url : 'http://localhost';
    this.port = (process.env.ENV_NAME || 'LOCAL') !== 'LOCAL' ? port : port;
    this.servicename = servicename;
    this.endpoints = endpoints;
  }

  public getFullURL(endpointKey?) {
    let endpoint = '';
    if (endpointKey && this.endpoints[endpointKey]) {
      endpoint = `/${this.endpoints[endpointKey]}`;
    }
    return `${this.url}:${this.port}/${this.servicename}${endpoint}`;
  }
}
