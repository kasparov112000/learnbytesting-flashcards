import { ObjectID } from 'mongodb';
import { Query, Error } from 'mongoose';
import { DbQuery, DbPagedResults } from '../models/db-service';
import { ConnectionConfig } from './configuration/connection-config';
import { MongooseQueryParser } from 'mongoose-query-parser';

export abstract class DbServiceBase {
    private db: any;
    private readonly limitKey = 'pageSize';
    private readonly skipKey = 'page';

    private debugInfo = (info?: string, debugObject?: any) => { };

    get dbModel() {
        return this.db.models[this.connection.modelName];
    }

    constructor(protected connection: ConnectionConfig, protected mongoose: any) {
        if (connection.verboseDebugEnabled) {
            this.debugInfo = this.debug;
            this.debugInfo('WARNING: VERBOSE DEBUG ENABLED', this.connection);
        }
    }

    public async grid(aggregate) {
        return this.dbModel.aggregate(aggregate).allowDiskUse(true).collation({ locale: 'en_US', numericOrdering: true });
     }

    public connect(): Promise<string> {
        return new Promise((resolve, reject) => {
            if (this.connection && this.connection.dbUrl && this.connection.options) {
                this.mongoose.connect(this.connection.dbUrl, this.connection.options)
                    .then(() => {
                        this.db = this.mongoose.connection;
                        this.debugInfo('Schema Path', this.connection.schemaPath);
                        require(this.connection.schemaPath);
                        resolve(JSON.stringify(this.connection));
                    }, err => {
                        reject(err);
                    }).catch(err =>
                         console.log('there was an error connecting'))
            } else {
            this.debugInfo('WARNING: ONE OF THE CONNECTION OPTION IS EMPTY',
            this.connection.dbUrl);

            }
        });
    }

    public close(): void {
        if (this.db) {
            return this.db.close();
        }
    }

    public async find<TResult = any>(req): Promise<TResult> {
        const query = this.getQuery(req);
        if (req.query && req.query.page && req.query.pageSize) {
        } else {
            return await query.exec();
        }
    }

    public async findPaged<TResult>(req): Promise<DbPagedResults<TResult>> {
        const query = this.getQuery(req);
        console.log('query: findPaged()', query);
        return await this.handlePagedResult<TResult>(query);
    }

    public async findById<TResult = any>(id): Promise<TResult> {
        return this.dbModel
            .findById(id)
            .lean();
    }

    public async create(model): Promise<any> {
        if (!model) {
            throw new Error('No payload was provided to create.');
        }

        this.debugInfo('Create', model);
        const createdDocument = await this.dbModel.create(model);
        return createdDocument.toObject();
    }

    public async update<TResult = any>(updateRequest): Promise<TResult> {
        if (!updateRequest || !updateRequest.params || !updateRequest.params.id) {
            throw new Error('Invalid data provided for update. Check the payload and that an id was passed to the service correctly.');
        }

        const result = await this.dbModel.findByIdAndUpdate(
            updateRequest.params.id,
            { $set: updateRequest.body },
            { new: true }
        );

        if (this.connection.loggerEnabled) {
            console.log('update result', result);
        }

        if (!result) {
            throw new Error(`There was no data found based on the id "${updateRequest.params.id}" to update.`);
        }

        return result;
    }

    public async delete<TResult = any>(deleteRequest): Promise<TResult> {
        return await this.dbModel.remove({ _id: new ObjectID(deleteRequest.params.id) });
    }

    protected async handlePagedResult<TResult>(query: Query<TResult, any>): Promise<DbPagedResults<TResult>> {
        const result = await query.exec();

        query.limit(void 0);
        query.skip(void 0);

        const count = await query.countDocuments().lean();
        const dbPagedResults = new DbPagedResults<TResult>({
            count,
            result,
        });

        return dbPagedResults;
    }

    protected getQuery(req: any): any {
        const queryBuilder = this.getQueryBuilder(req);
        console.log('queryBuilder.filter: ', queryBuilder.filter);
        console.log(' queryBuilder.options: ',  queryBuilder.options);

        return this.dbModel.find(queryBuilder.filter, queryBuilder.projection, queryBuilder.options, this.handleQuery);
    }

    protected getQueryBuilder(req: any): DbQuery {
        const dbQuery = new DbQuery();

        if (req.params) {
            this.debugInfo('Found: Request Parameters', req.params);
            Object.assign(dbQuery.filter, this.getParams(req.params));
        }

        if (!Object.keys(req.query).length) {
            return dbQuery;
        }
        const predefinedValues = Object.assign({}, this.getPagingOptions(req.query));

        const parser = new MongooseQueryParser({
            limitKey: this.limitKey,
            skipKey: this.skipKey,
        });

        const parsedQuery = parser.parse(req.query, predefinedValues);
        if (!parsedQuery) {
            return dbQuery;
        }

        Object.assign(dbQuery.filter, parsedQuery.filter);
        Object.assign(dbQuery.projection, parsedQuery.select);

        Object.assign(dbQuery.options, {
            limit: predefinedValues.pageSize,
            skip: predefinedValues.page,
            sort: parsedQuery.sort,
        });

        return dbQuery;
    }

    protected getPagingOptions(query: any): any {
        let pagingOptions;

        if (query && query.pageSize && query.page) {
            this.debugInfo('Found: Pagination Parameters', query);
            pagingOptions = {
                page: query.pageSize * (query.page - 1),
                pageSize: +query.pageSize
            };
        }

        return pagingOptions;
    }

    protected getSortOptions(query): any {
        const sortOptions = {};
        if (!query) {
            return sortOptions;
        }

        if (query.sortProperty && query.sortOrder) {
            sortOptions[query.sortProperty] = query.sortOrder;
        }

        return sortOptions;
    }

    protected getParams(params): any {
    console.log('params: getParams ', params);
        if (!params) {
            return;
        }
        const filterObject = {};
        Object.keys(params)
            .filter(key => params[key])
            .map((key) => {
                if (key === 'id') {
                    filterObject['_id'] = params[key];
                } else {
                    filterObject[key] = params[key];
                }
            });

        return filterObject
    }

    private debug(info?: string, debugObject?: any): void {
        if (info) {
            console.log('=========================================================================');
            console.log(info);
        }

        console.log('=========================================================================');

        if (debugObject) {
            console.log(debugObject);
            console.log('=========================================================================');
        }
    }

    private handleQuery(err: Error, doc) {
        if (err) {
            console.log('=========================================================================');
            console.log('Error in DbServiceBase');
            console.log('=========================================================================');
            console.log(err);
            console.log(doc);
            console.log('=========================================================================');
        }
    }
}
