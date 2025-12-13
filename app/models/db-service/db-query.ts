export class DbQuery {
    public options: any = {
        lean: true,
    };
    public filter: any = {};
    public sort: any = {};
    public projection: any = {};

    constructor(init?: { options?: any, filter?: any, sort?: any, projection?: any}) {
        if (init) {
            this.options = init.options;
            this.filter = init.filter;
            this.sort = init.sort;
            this.projection = init.projection;

            if (init.options) {
                Object.assign(this.options, init.options);
            }
        }
    }
}
