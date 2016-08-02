function isFunction(functionToCheck) {
    var getType = {};
    return functionToCheck && getType.toString.call(functionToCheck) === '[object Function]';
}

let TIMEOUT = Symbol("timeout");
let RESOLVED = Symbol("resolved");
let REJECTED = Symbol("rejected");

function _timeout(ms) {
    return new Promise((resolve)=> {
        setTimeout(()=>resolve({state: TIMEOUT}), ms);
    });
}

module.exports = function (moin) {
    let newID = require("hat").rack();

    let logger = moin.getLogger("events");

    let _handler = {};

    let _fieldFilter = {};
    let _fields = new Set();

    let _callbacks = {};
    let _handlerSet = new Set();

    let _filterOrder = [];

    function recalculateFilterOrder() {
        _filterOrder = [];
        for (let field of _fields) {
            _filterOrder.push({
                field,
                size: _fieldFilter[field]._handler.size - (_fieldFilter[field]._dynamicCount) * 0.5
            });
        }
        _filterOrder.sort(function ({size:a}, {size:b}) {
            if (a == b)return 0;
            return a > b ? -1 : 1;
        });
    }


    function getHandler(event, count = false) {

        let handlers = new Set(_handlerSet);
        let _count = new Map();

        if (count) {
            handlers.forEach((id)=>_count.set(id, 0));
        }

        function filterProperty(field, value) {
            //Check these Candidates. Ever ID that remains in this list, should be filtered out
            let toCheck = new Set();

            //Add all Handler which are filtered by this property and are still in the handlers Set
            _fieldFilter[field]._handler.forEach(function (handlerId) {
                if (handlers.has(handlerId))toCheck.add(handlerId);
            });

            if (toCheck.size == 0)return;

            //Remove dynamic filters which return true
            toCheck.forEach(function (handlerId) {
                if (_fieldFilter[field]._dynamic.hasOwnProperty(handlerId)) {
                    if (_fieldFilter[field]._dynamic[handlerId](value)) {
                        toCheck.delete(handlerId);
                        if (count)_count.set(handlerId, _count.get(handlerId) + 1);
                    }
                }
            });

            //Remove static filters which have the needed value
            if (_fieldFilter[field]._static.hasOwnProperty(value)) {
                _fieldFilter[field]._static[value].forEach(function (handlerId) {
                    toCheck.delete(handlerId);
                    if (count)_count.set(handlerId, _count.get(handlerId) + 1);
                });
            }


            //remove the remaining candidates from handler list
            toCheck.forEach(function (handlerId) {
                handlers.delete(handlerId);
                if (count)_count.delete(handlerId);
            });
        }

        for (var i = 0; i < _filterOrder.length; i++) {
            if (handlers.size == 0)break;
            var field = _filterOrder[i].field;
            filterProperty(field, event[field]);
        }
        return count ? _count : handlers;
    }


    moin.on("unloadService", (serviceId)=> {
        _handler[serviceId].forEach(({id:handlerId,filter})=> {
            _handlerSet.delete(handlerId);
            delete _callbacks[handlerId];
            filter.forEach(({field,type,value})=> {
                switch (type) {
                    case "static":
                        delete _fieldFilter[field]._dynamic[handlerId];
                        _fieldFilter[field]._dynamicCount--;
                        break;
                    case "dynamic":
                        _fieldFilter[field]._static[value].delete(handlerId);
                        break;
                }
                _fieldFilter[field]._handler.delete(handlerId);
            });
        });
        delete _handler[serviceId];
        recalculateFilterOrder();
    });
    moin.on("loadService", (handler)=> {
        let id = handler.getId();

        _handler[id] = [];

        handler.addApi("on", function (filter = {}, callback = null) {
            if (callback == null) {
                if (typeof filter == "function") {
                    [filter, callback] = [{}, filter];
                } else {
                    throw "No Callback given";
                }
            }

            let handlerId = newID();
            let fields = [];
            Object.keys(filter).forEach(function (field) {
                if (!_fieldFilter.hasOwnProperty(field)) {
                    _fieldFilter[field] = {
                        _handler: new Set(),
                        _static: {},
                        _dynamic: {},
                        _dynamicCount: 0
                    };
                    _fields.add(field);
                }
                _fieldFilter[field]._handler.add(handlerId);

                if (isFunction(filter[field])) {
                    fields.push({field, type: "dynamic"});
                    _fieldFilter[field]._dynamic[handlerId] = filter[field];
                    _fieldFilter[field]._dynamicCount++;
                } else {
                    fields.push({field, type: "static", value: filter[field]});
                    if (!_fieldFilter[field]._static.hasOwnProperty(filter[field]))_fieldFilter[field]._static[filter[field]] = new Set();
                    _fieldFilter[field]._static[filter[field]].add(handlerId);
                }
            });
            _handler[id].push({
                id: handlerId,
                filter: fields
            });
            _callbacks[handlerId] = callback;
            _handlerSet.add(handlerId);
            recalculateFilterOrder();
        });
        handler.addApi("emit", function (eventName, data = {}, timeout = null) {
            //Todo: Better way to get a copy of the data
            let filter = JSON.parse(JSON.stringify(data));
            filter.event = eventName;

            let handler = getHandler(filter);
            if (handler.length == 0) {
                return Promise.resolve({
                    values: [],
                    errors: [],
                    stats: {
                        handler: 0,
                        rejected: 0,
                        resolved: 0,
                        timeout: 0
                    }
                });
            }

            let promises = [];
            handler.forEach(fnc=> {
                promises.push(
                    Promise.resolve(new Promise((resolve, reject)=> {
                            try {
                                resolve(_callbacks[fnc](filter));
                            } catch (e) {
                                reject(e);
                            }
                        }))
                        .then((value)=> {
                            return {state: RESOLVED, value};
                        }, (error)=> {
                            return {state: REJECTED, error};
                        })
                );
            });

            if (timeout != null) {
                promises = promises.map(fnc=> {
                    return Promise.race([fnc, _timeout(timeout)]);
                });
            }

            return Promise.all(promises).then((results)=> {
                let stats = {
                    handler: results.length,
                    rejected: 0,
                    resolved: 0,
                    timeout: 0
                };
                let values = [];
                let errors = [];
                results.forEach(function (result) {
                    switch (result.state) {
                        case REJECTED:
                            errors.push(result.error);
                            stats.rejected++;
                            break;
                        case TIMEOUT:
                            stats.timeout++;
                            break;
                        case RESOLVED:
                            if (result.value != undefined)values.push(result.value);
                            stats.resolved++;
                            break;
                    }
                });
                return {
                    values, errors, stats
                };
            });
        });
        handler.addApi("act", function (eventName, data = {}) {
            //Todo: Better way to get a copy of the data
            let filter = JSON.parse(JSON.stringify(data));
            filter.event = eventName;

            let handler = getHandler(filter, true);
            if (handler.length == 0) {
                return Promise.resolve({
                    error: "No Handler"
                });
            }

            let max = 0;
            let maxId = 0;
            handler.forEach((count, fnc)=> {
                if (count > max)maxId = fnc;
            });

            return new Promise((resolve, reject)=> {
                try {
                    resolve(_callbacks[maxId](filter));
                } catch (e) {
                    reject(e);
                }
            })
                .then((value)=> {
                    return {value};
                }, (error)=> {
                    return {error};
                });
        });
    });
};