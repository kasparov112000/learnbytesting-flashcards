export class DbPagedResults<TResult>  {
    public result: TResult;
    public count: number;

    constructor(init?: { result?: TResult, count?: number }) {
        if (init) {
            Object.assign(this, init);
        }
    }
}
