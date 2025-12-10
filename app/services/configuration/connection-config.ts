import { ConnectionConfigOptions } from './connection-config-options';

export class ConnectionConfig {
    public env !: string;
    public host !: string;
    public dbUrl !: string;
    public modelName !: string;
    public schemaPath !: string;
    public verboseDebugEnabled: boolean = true;
    public loggerEnabled: boolean = true;
    public options !: ConnectionConfigOptions;

    constructor(init?: {
        env?: string,
        host?: string,
        dbUrl?: string,
        modelName?: string,
        schemaPath?: string,
        debugInfo?: boolean,
        options?: ConnectionConfigOptions,
    }) {
        if (init) {
            Object.assign(this, init);
        }
    }
}
