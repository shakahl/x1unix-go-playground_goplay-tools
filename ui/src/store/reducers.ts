import {Action, ActionType} from './actions';
import {DEMO_CODE} from "../editor/props";
import {State} from "./state";

const initialState = {
    code: DEMO_CODE,
};

type Reducer<T> = (s: State, a: Action<T>) => State;

const reducers: {[k in ActionType]: Reducer<any>} = {
    [ActionType.FILE_CHANGE]: (s, a: Action<string>) => {
        s.code = a.payload;
        return s;
    },
    [ActionType.IMPORT_FILE]: (s, a: Action<string>) => {
        s.code = a.payload;
        return s;
    }
};

export function rootReducer(state = initialState, action: Action) {
    const newState = Object.assign({}, state);
    const r = reducers[action.type];
    if (!r) {
        return newState;
    }

    return reducers[action.type](newState, action);
}
