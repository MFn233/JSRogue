var Module = typeof Module !== "undefined" ? Module : {};
if (typeof window === "object") { Module["arguments"] = window.location.search.substr(1).trim().split("&"); if (!Module["arguments"][0]) Module["arguments"] = [] }
var moduleOverrides = {};
var key;
for (key in Module) { if (Module.hasOwnProperty(key)) { moduleOverrides[key] = Module[key] } }
Module["arguments"] = [];
Module["thisProgram"] = "./this.program";
Module["quit"] = (function(status, toThrow) { throw toThrow });
Module["preRun"] = [];
Module["postRun"] = [];
var ENVIRONMENT_IS_WEB = false;
var ENVIRONMENT_IS_WORKER = false;
var ENVIRONMENT_IS_NODE = false;
var ENVIRONMENT_IS_SHELL = false;
ENVIRONMENT_IS_WEB = typeof window === "object";
ENVIRONMENT_IS_WORKER = typeof importScripts === "function";
ENVIRONMENT_IS_NODE = typeof process === "object" && typeof require === "function" && !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_WORKER;
ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;
var scriptDirectory = "";

function locateFile(path) { if (Module["locateFile"]) { return Module["locateFile"](path, scriptDirectory) } else { return scriptDirectory + path } }
if (ENVIRONMENT_IS_NODE) {
    scriptDirectory = __dirname + "/";
    var nodeFS;
    var nodePath;
    Module["read"] = function shell_read(filename, binary) {
        var ret;
        if (!nodeFS) nodeFS = require("fs");
        if (!nodePath) nodePath = require("path");
        filename = nodePath["normalize"](filename);
        ret = nodeFS["readFileSync"](filename);
        return binary ? ret : ret.toString()
    };
    Module["readBinary"] = function readBinary(filename) {
        var ret = Module["read"](filename, true);
        if (!ret.buffer) { ret = new Uint8Array(ret) }
        assert(ret.buffer);
        return ret
    };
    if (process["argv"].length > 1) { Module["thisProgram"] = process["argv"][1].replace(/\\/g, "/") }
    Module["arguments"] = process["argv"].slice(2);
    if (typeof module !== "undefined") { module["exports"] = Module }
    process["on"]("uncaughtException", (function(ex) { if (!(ex instanceof ExitStatus)) { throw ex } }));
    process["on"]("unhandledRejection", abort);
    Module["quit"] = (function(status) { process["exit"](status) });
    Module["inspect"] = (function() { return "[Emscripten Module object]" })
} else if (ENVIRONMENT_IS_SHELL) {
    if (typeof read != "undefined") { Module["read"] = function shell_read(f) { return read(f) } }
    Module["readBinary"] = function readBinary(f) {
        var data;
        if (typeof readbuffer === "function") { return new Uint8Array(readbuffer(f)) }
        data = read(f, "binary");
        assert(typeof data === "object");
        return data
    };
    if (typeof scriptArgs != "undefined") { Module["arguments"] = scriptArgs } else if (typeof arguments != "undefined") { Module["arguments"] = arguments }
    if (typeof quit === "function") { Module["quit"] = (function(status) { quit(status) }) }
} else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
    if (ENVIRONMENT_IS_WORKER) { scriptDirectory = self.location.href } else if (document.currentScript) { scriptDirectory = document.currentScript.src }
    if (scriptDirectory.indexOf("blob:") !== 0) { scriptDirectory = scriptDirectory.substr(0, scriptDirectory.lastIndexOf("/") + 1) } else { scriptDirectory = "" }
    Module["read"] = function shell_read(url) {
        var xhr = new XMLHttpRequest;
        xhr.open("GET", url, false);
        xhr.send(null);
        return xhr.responseText
    };
    if (ENVIRONMENT_IS_WORKER) {
        Module["readBinary"] = function readBinary(url) {
            var xhr = new XMLHttpRequest;
            xhr.open("GET", url, false);
            xhr.responseType = "arraybuffer";
            xhr.send(null);
            return new Uint8Array(xhr.response)
        }
    }
    Module["readAsync"] = function readAsync(url, onload, onerror) {
        var xhr = new XMLHttpRequest;
        xhr.open("GET", url, true);
        xhr.responseType = "arraybuffer";
        xhr.onload = function xhr_onload() {
            if (xhr.status == 200 || xhr.status == 0 && xhr.response) { onload(xhr.response); return }
            onerror()
        };
        xhr.onerror = onerror;
        xhr.send(null)
    };
    Module["setWindowTitle"] = (function(title) { document.title = title })
} else {}
var out = Module["print"] || (typeof console !== "undefined" ? console.log.bind(console) : typeof print !== "undefined" ? print : null);
var err = Module["printErr"] || (typeof printErr !== "undefined" ? printErr : typeof console !== "undefined" && console.warn.bind(console) || out);
for (key in moduleOverrides) { if (moduleOverrides.hasOwnProperty(key)) { Module[key] = moduleOverrides[key] } }
moduleOverrides = undefined;
var STACK_ALIGN = 16;

function staticAlloc(size) {
    var ret = STATICTOP;
    STATICTOP = STATICTOP + size + 15 & -16;
    return ret
}

function dynamicAlloc(size) {
    var ret = HEAP32[DYNAMICTOP_PTR >> 2];
    var end = ret + size + 15 & -16;
    HEAP32[DYNAMICTOP_PTR >> 2] = end;
    if (end >= TOTAL_MEMORY) { var success = enlargeMemory(); if (!success) { HEAP32[DYNAMICTOP_PTR >> 2] = ret; return 0 } }
    return ret
}

function alignMemory(size, factor) { if (!factor) factor = STACK_ALIGN; var ret = size = Math.ceil(size / factor) * factor; return ret }

function getNativeTypeSize(type) {
    switch (type) {
        case "i1":
        case "i8":
            return 1;
        case "i16":
            return 2;
        case "i32":
            return 4;
        case "i64":
            return 8;
        case "float":
            return 4;
        case "double":
            return 8;
        default:
            {
                if (type[type.length - 1] === "*") { return 4 } else if (type[0] === "i") {
                    var bits = parseInt(type.substr(1));
                    assert(bits % 8 === 0);
                    return bits / 8
                } else { return 0 }
            }
    }
}

function warnOnce(text) {
    if (!warnOnce.shown) warnOnce.shown = {};
    if (!warnOnce.shown[text]) {
        warnOnce.shown[text] = 1;
        err(text)
    }
}
var asm2wasmImports = { "f64-rem": (function(x, y) { return x % y }), "debugger": (function() { debugger }) };
var jsCallStartIndex = 1;
var functionPointers = new Array(0);

function addFunction(func, sig) { var base = 0; for (var i = base; i < base + 0; i++) { if (!functionPointers[i]) { functionPointers[i] = func; return jsCallStartIndex + i } } throw "Finished up all reserved function pointers. Use a higher value for RESERVED_FUNCTION_POINTERS." }

function dynCall(sig, ptr, args) { if (args && args.length) { return Module["dynCall_" + sig].apply(null, [ptr].concat(args)) } else { return Module["dynCall_" + sig].call(null, ptr) } }
var Runtime = { dynCall: dynCall };
var GLOBAL_BASE = 1024;
var ABORT = false;
var EXITSTATUS = 0;

function assert(condition, text) { if (!condition) { abort("Assertion failed: " + text) } }

function getCFunc(ident) {
    var func = Module["_" + ident];
    assert(func, "Cannot call unknown function " + ident + ", make sure it is exported");
    return func
}
var JSfuncs = {
    "stackSave": (function() { stackSave() }),
    "stackRestore": (function() { stackRestore() }),
    "arrayToC": (function(arr) {
        var ret = stackAlloc(arr.length);
        writeArrayToMemory(arr, ret);
        return ret
    }),
    "stringToC": (function(str) {
        var ret = 0;
        if (str !== null && str !== undefined && str !== 0) {
            var len = (str.length << 2) + 1;
            ret = stackAlloc(len);
            stringToUTF8(str, ret, len)
        }
        return ret
    })
};
var toC = { "string": JSfuncs["stringToC"], "array": JSfuncs["arrayToC"] };

function ccall(ident, returnType, argTypes, args, opts) {
    function convertReturnValue(ret) { if (returnType === "string") return Pointer_stringify(ret); if (returnType === "boolean") return Boolean(ret); return ret }
    var func = getCFunc(ident);
    var cArgs = [];
    var stack = 0;
    if (args) {
        for (var i = 0; i < args.length; i++) {
            var converter = toC[argTypes[i]];
            if (converter) {
                if (stack === 0) stack = stackSave();
                cArgs[i] = converter(args[i])
            } else { cArgs[i] = args[i] }
        }
    }
    var ret = func.apply(null, cArgs);
    if (typeof EmterpreterAsync === "object" && EmterpreterAsync.state) {
        return new Promise((function(resolve) {
            EmterpreterAsync.restartFunc = func;
            EmterpreterAsync.asyncFinalizers.push((function(ret) {
                if (stack !== 0) stackRestore(stack);
                resolve(convertReturnValue(ret))
            }))
        }))
    }
    ret = convertReturnValue(ret);
    if (stack !== 0) stackRestore(stack);
    if (opts && opts.async) return Promise.resolve(ret);
    return ret
}

function setValue(ptr, value, type, noSafe) {
    type = type || "i8";
    if (type.charAt(type.length - 1) === "*") type = "i32";
    switch (type) {
        case "i1":
            HEAP8[ptr >> 0] = value;
            break;
        case "i8":
            HEAP8[ptr >> 0] = value;
            break;
        case "i16":
            HEAP16[ptr >> 1] = value;
            break;
        case "i32":
            HEAP32[ptr >> 2] = value;
            break;
        case "i64":
            tempI64 = [value >>> 0, (tempDouble = value, +Math_abs(tempDouble) >= +1 ? tempDouble > +0 ? (Math_min(+Math_floor(tempDouble / +4294967296), +4294967295) | 0) >>> 0 : ~~+Math_ceil((tempDouble - +(~~tempDouble >>> 0)) / +4294967296) >>> 0 : 0)], HEAP32[ptr >> 2] = tempI64[0], HEAP32[ptr + 4 >> 2] = tempI64[1];
            break;
        case "float":
            HEAPF32[ptr >> 2] = value;
            break;
        case "double":
            HEAPF64[ptr >> 3] = value;
            break;
        default:
            abort("invalid type for setValue: " + type)
    }
}
var ALLOC_NORMAL = 0;
var ALLOC_STATIC = 2;
var ALLOC_NONE = 4;

function allocate(slab, types, allocator, ptr) {
    var zeroinit, size;
    if (typeof slab === "number") {
        zeroinit = true;
        size = slab
    } else {
        zeroinit = false;
        size = slab.length
    }
    var singleType = typeof types === "string" ? types : null;
    var ret;
    if (allocator == ALLOC_NONE) { ret = ptr } else { ret = [typeof _malloc === "function" ? _malloc : staticAlloc, stackAlloc, staticAlloc, dynamicAlloc][allocator === undefined ? ALLOC_STATIC : allocator](Math.max(size, singleType ? 1 : types.length)) }
    if (zeroinit) {
        var stop;
        ptr = ret;
        assert((ret & 3) == 0);
        stop = ret + (size & ~3);
        for (; ptr < stop; ptr += 4) { HEAP32[ptr >> 2] = 0 }
        stop = ret + size;
        while (ptr < stop) { HEAP8[ptr++ >> 0] = 0 }
        return ret
    }
    if (singleType === "i8") { if (slab.subarray || slab.slice) { HEAPU8.set(slab, ret) } else { HEAPU8.set(new Uint8Array(slab), ret) } return ret }
    var i = 0,
        type, typeSize, previousType;
    while (i < size) {
        var curr = slab[i];
        type = singleType || types[i];
        if (type === 0) { i++; continue }
        if (type == "i64") type = "i32";
        setValue(ret + i, curr, type);
        if (previousType !== type) {
            typeSize = getNativeTypeSize(type);
            previousType = type
        }
        i += typeSize
    }
    return ret
}

function getMemory(size) { if (!staticSealed) return staticAlloc(size); if (!runtimeInitialized) return dynamicAlloc(size); return _malloc(size) }

function Pointer_stringify(ptr, length) {
    if (length === 0 || !ptr) return "";
    var hasUtf = 0;
    var t;
    var i = 0;
    while (1) {
        t = HEAPU8[ptr + i >> 0];
        hasUtf |= t;
        if (t == 0 && !length) break;
        i++;
        if (length && i == length) break
    }
    if (!length) length = i;
    var ret = "";
    if (hasUtf < 128) {
        var MAX_CHUNK = 1024;
        var curr;
        while (length > 0) {
            curr = String.fromCharCode.apply(String, HEAPU8.subarray(ptr, ptr + Math.min(length, MAX_CHUNK)));
            ret = ret ? ret + curr : curr;
            ptr += MAX_CHUNK;
            length -= MAX_CHUNK
        }
        return ret
    }
    return UTF8ToString(ptr)
}
var UTF8Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf8") : undefined;

function UTF8ArrayToString(u8Array, idx) {
    var endPtr = idx;
    while (u8Array[endPtr]) ++endPtr;
    if (endPtr - idx > 16 && u8Array.subarray && UTF8Decoder) { return UTF8Decoder.decode(u8Array.subarray(idx, endPtr)) } else {
        var u0, u1, u2, u3, u4, u5;
        var str = "";
        while (1) {
            u0 = u8Array[idx++];
            if (!u0) return str;
            if (!(u0 & 128)) { str += String.fromCharCode(u0); continue }
            u1 = u8Array[idx++] & 63;
            if ((u0 & 224) == 192) { str += String.fromCharCode((u0 & 31) << 6 | u1); continue }
            u2 = u8Array[idx++] & 63;
            if ((u0 & 240) == 224) { u0 = (u0 & 15) << 12 | u1 << 6 | u2 } else {
                u3 = u8Array[idx++] & 63;
                if ((u0 & 248) == 240) { u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | u3 } else {
                    u4 = u8Array[idx++] & 63;
                    if ((u0 & 252) == 248) { u0 = (u0 & 3) << 24 | u1 << 18 | u2 << 12 | u3 << 6 | u4 } else {
                        u5 = u8Array[idx++] & 63;
                        u0 = (u0 & 1) << 30 | u1 << 24 | u2 << 18 | u3 << 12 | u4 << 6 | u5
                    }
                }
            }
            if (u0 < 65536) { str += String.fromCharCode(u0) } else {
                var ch = u0 - 65536;
                str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023)
            }
        }
    }
}

function UTF8ToString(ptr) { return UTF8ArrayToString(HEAPU8, ptr) }

function stringToUTF8Array(str, outU8Array, outIdx, maxBytesToWrite) {
    if (!(maxBytesToWrite > 0)) return 0;
    var startIdx = outIdx;
    var endIdx = outIdx + maxBytesToWrite - 1;
    for (var i = 0; i < str.length; ++i) {
        var u = str.charCodeAt(i);
        if (u >= 55296 && u <= 57343) {
            var u1 = str.charCodeAt(++i);
            u = 65536 + ((u & 1023) << 10) | u1 & 1023
        }
        if (u <= 127) {
            if (outIdx >= endIdx) break;
            outU8Array[outIdx++] = u
        } else if (u <= 2047) {
            if (outIdx + 1 >= endIdx) break;
            outU8Array[outIdx++] = 192 | u >> 6;
            outU8Array[outIdx++] = 128 | u & 63
        } else if (u <= 65535) {
            if (outIdx + 2 >= endIdx) break;
            outU8Array[outIdx++] = 224 | u >> 12;
            outU8Array[outIdx++] = 128 | u >> 6 & 63;
            outU8Array[outIdx++] = 128 | u & 63
        } else if (u <= 2097151) {
            if (outIdx + 3 >= endIdx) break;
            outU8Array[outIdx++] = 240 | u >> 18;
            outU8Array[outIdx++] = 128 | u >> 12 & 63;
            outU8Array[outIdx++] = 128 | u >> 6 & 63;
            outU8Array[outIdx++] = 128 | u & 63
        } else if (u <= 67108863) {
            if (outIdx + 4 >= endIdx) break;
            outU8Array[outIdx++] = 248 | u >> 24;
            outU8Array[outIdx++] = 128 | u >> 18 & 63;
            outU8Array[outIdx++] = 128 | u >> 12 & 63;
            outU8Array[outIdx++] = 128 | u >> 6 & 63;
            outU8Array[outIdx++] = 128 | u & 63
        } else {
            if (outIdx + 5 >= endIdx) break;
            outU8Array[outIdx++] = 252 | u >> 30;
            outU8Array[outIdx++] = 128 | u >> 24 & 63;
            outU8Array[outIdx++] = 128 | u >> 18 & 63;
            outU8Array[outIdx++] = 128 | u >> 12 & 63;
            outU8Array[outIdx++] = 128 | u >> 6 & 63;
            outU8Array[outIdx++] = 128 | u & 63
        }
    }
    outU8Array[outIdx] = 0;
    return outIdx - startIdx
}

function stringToUTF8(str, outPtr, maxBytesToWrite) { return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite) }

function lengthBytesUTF8(str) { var len = 0; for (var i = 0; i < str.length; ++i) { var u = str.charCodeAt(i); if (u >= 55296 && u <= 57343) u = 65536 + ((u & 1023) << 10) | str.charCodeAt(++i) & 1023; if (u <= 127) {++len } else if (u <= 2047) { len += 2 } else if (u <= 65535) { len += 3 } else if (u <= 2097151) { len += 4 } else if (u <= 67108863) { len += 5 } else { len += 6 } } return len }
var UTF16Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-16le") : undefined;

function allocateUTF8(str) { var size = lengthBytesUTF8(str) + 1; var ret = _malloc(size); if (ret) stringToUTF8Array(str, HEAP8, ret, size); return ret }

function allocateUTF8OnStack(str) {
    var size = lengthBytesUTF8(str) + 1;
    var ret = stackAlloc(size);
    stringToUTF8Array(str, HEAP8, ret, size);
    return ret
}

function demangle(func) { return func }

function demangleAll(text) { var regex = /__Z[\w\d_]+/g; return text.replace(regex, (function(x) { var y = demangle(x); return x === y ? x : y + " [" + x + "]" })) }

function jsStackTrace() { var err = new Error; if (!err.stack) { try { throw new Error(0) } catch (e) { err = e } if (!err.stack) { return "(no stack trace available)" } } return err.stack.toString() }

function stackTrace() { var js = jsStackTrace(); if (Module["extraStackTrace"]) js += "\n" + Module["extraStackTrace"](); return demangleAll(js) }
var WASM_PAGE_SIZE = 65536;
var ASMJS_PAGE_SIZE = 16777216;
var MIN_TOTAL_MEMORY = 16777216;

function alignUp(x, multiple) { if (x % multiple > 0) { x += multiple - x % multiple } return x }
var buffer, HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;

function updateGlobalBuffer(buf) { Module["buffer"] = buffer = buf }

function updateGlobalBufferViews() {
    Module["HEAP8"] = HEAP8 = new Int8Array(buffer);
    Module["HEAP16"] = HEAP16 = new Int16Array(buffer);
    Module["HEAP32"] = HEAP32 = new Int32Array(buffer);
    Module["HEAPU8"] = HEAPU8 = new Uint8Array(buffer);
    Module["HEAPU16"] = HEAPU16 = new Uint16Array(buffer);
    Module["HEAPU32"] = HEAPU32 = new Uint32Array(buffer);
    Module["HEAPF32"] = HEAPF32 = new Float32Array(buffer);
    Module["HEAPF64"] = HEAPF64 = new Float64Array(buffer)
}
var STATIC_BASE, STATICTOP, staticSealed;
var STACK_BASE, STACKTOP, STACK_MAX;
var DYNAMIC_BASE, DYNAMICTOP_PTR;
STATIC_BASE = STATICTOP = STACK_BASE = STACKTOP = STACK_MAX = DYNAMIC_BASE = DYNAMICTOP_PTR = 0;
staticSealed = false;

function abortOnCannotGrowMemory() { abort("Cannot enlarge memory arrays. Either (1) compile with  -s TOTAL_MEMORY=X  with X higher than the current value " + TOTAL_MEMORY + ", (2) compile with  -s ALLOW_MEMORY_GROWTH=1  which allows increasing the size at runtime, or (3) if you want malloc to return NULL (0) instead of this abort, compile with  -s ABORTING_MALLOC=0 ") }
if (!Module["reallocBuffer"]) Module["reallocBuffer"] = (function(size) {
    var ret;
    try {
        var oldHEAP8 = HEAP8;
        ret = new ArrayBuffer(size);
        var temp = new Int8Array(ret);
        temp.set(oldHEAP8)
    } catch (e) { return false }
    var success = _emscripten_replace_memory(ret);
    if (!success) return false;
    return ret
});

function enlargeMemory() {
    var PAGE_MULTIPLE = Module["usingWasm"] ? WASM_PAGE_SIZE : ASMJS_PAGE_SIZE;
    var LIMIT = 2147483648 - PAGE_MULTIPLE;
    if (HEAP32[DYNAMICTOP_PTR >> 2] > LIMIT) { return false }
    var OLD_TOTAL_MEMORY = TOTAL_MEMORY;
    TOTAL_MEMORY = Math.max(TOTAL_MEMORY, MIN_TOTAL_MEMORY);
    while (TOTAL_MEMORY < HEAP32[DYNAMICTOP_PTR >> 2]) { if (TOTAL_MEMORY <= 536870912) { TOTAL_MEMORY = alignUp(2 * TOTAL_MEMORY, PAGE_MULTIPLE) } else { TOTAL_MEMORY = Math.min(alignUp((3 * TOTAL_MEMORY + 2147483648) / 4, PAGE_MULTIPLE), LIMIT) } }
    var replacement = Module["reallocBuffer"](TOTAL_MEMORY);
    if (!replacement || replacement.byteLength != TOTAL_MEMORY) { TOTAL_MEMORY = OLD_TOTAL_MEMORY; return false }
    updateGlobalBuffer(replacement);
    updateGlobalBufferViews();
    return true
}
var byteLength;
try {
    byteLength = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get);
    byteLength(new ArrayBuffer(4))
} catch (e) { byteLength = (function(buffer) { return buffer.byteLength }) }
var TOTAL_STACK = Module["TOTAL_STACK"] || 5242880;
var TOTAL_MEMORY = Module["TOTAL_MEMORY"] || 16777216;
if (TOTAL_MEMORY < TOTAL_STACK) err("TOTAL_MEMORY should be larger than TOTAL_STACK, was " + TOTAL_MEMORY + "! (TOTAL_STACK=" + TOTAL_STACK + ")");
if (Module["buffer"]) { buffer = Module["buffer"] } else {
    if (typeof WebAssembly === "object" && typeof WebAssembly.Memory === "function") {
        Module["wasmMemory"] = new WebAssembly.Memory({ "initial": TOTAL_MEMORY / WASM_PAGE_SIZE });
        buffer = Module["wasmMemory"].buffer
    } else { buffer = new ArrayBuffer(TOTAL_MEMORY) }
    Module["buffer"] = buffer
}
updateGlobalBufferViews();

function getTotalMemory() { return TOTAL_MEMORY }

function callRuntimeCallbacks(callbacks) { while (callbacks.length > 0) { var callback = callbacks.shift(); if (typeof callback == "function") { callback(); continue } var func = callback.func; if (typeof func === "number") { if (callback.arg === undefined) { Module["dynCall_v"](func) } else { Module["dynCall_vi"](func, callback.arg) } } else { func(callback.arg === undefined ? null : callback.arg) } } }
var __ATPRERUN__ = [];
var __ATINIT__ = [];
var __ATMAIN__ = [];
var __ATEXIT__ = [];
var __ATPOSTRUN__ = [];
var runtimeInitialized = false;
var runtimeExited = false;

function preRun() {
    if (Module["preRun"]) { if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]]; while (Module["preRun"].length) { addOnPreRun(Module["preRun"].shift()) } }
    callRuntimeCallbacks(__ATPRERUN__)
}

function ensureInitRuntime() {
    if (runtimeInitialized) return;
    runtimeInitialized = true;
    callRuntimeCallbacks(__ATINIT__)
}

function preMain() { callRuntimeCallbacks(__ATMAIN__) }

function exitRuntime() {
    callRuntimeCallbacks(__ATEXIT__);
    runtimeExited = true
}

function postRun() {
    if (Module["postRun"]) { if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]]; while (Module["postRun"].length) { addOnPostRun(Module["postRun"].shift()) } }
    callRuntimeCallbacks(__ATPOSTRUN__)
}

function addOnPreRun(cb) { __ATPRERUN__.unshift(cb) }

function addOnExit(cb) { __ATEXIT__.unshift(cb) }

function addOnPostRun(cb) { __ATPOSTRUN__.unshift(cb) }

function writeArrayToMemory(array, buffer) { HEAP8.set(array, buffer) }

function writeAsciiToMemory(str, buffer, dontAddNull) { for (var i = 0; i < str.length; ++i) { HEAP8[buffer++ >> 0] = str.charCodeAt(i) } if (!dontAddNull) HEAP8[buffer >> 0] = 0 }
var Math_abs = Math.abs;
var Math_ceil = Math.ceil;
var Math_floor = Math.floor;
var Math_min = Math.min;
var runDependencies = 0;
var runDependencyWatcher = null;
var dependenciesFulfilled = null;

function getUniqueRunDependency(id) { return id }

function addRunDependency(id) { runDependencies++; if (Module["monitorRunDependencies"]) { Module["monitorRunDependencies"](runDependencies) } }

function removeRunDependency(id) {
    runDependencies--;
    if (Module["monitorRunDependencies"]) { Module["monitorRunDependencies"](runDependencies) }
    if (runDependencies == 0) {
        if (runDependencyWatcher !== null) {
            clearInterval(runDependencyWatcher);
            runDependencyWatcher = null
        }
        if (dependenciesFulfilled) {
            var callback = dependenciesFulfilled;
            dependenciesFulfilled = null;
            callback()
        }
    }
}
Module["preloadedImages"] = {};
Module["preloadedAudios"] = {};
var dataURIPrefix = "data:application/octet-stream;base64,";

function isDataURI(filename) { return String.prototype.startsWith ? filename.startsWith(dataURIPrefix) : filename.indexOf(dataURIPrefix) === 0 }

function integrateWasmJS() {
    var wasmTextFile = "Rogue.wast";
    var wasmBinaryFile = "Rogue.wasm";
    var asmjsCodeFile = "Rogue.temp.asm.js";
    if (!isDataURI(wasmTextFile)) { wasmTextFile = locateFile(wasmTextFile) }
    if (!isDataURI(wasmBinaryFile)) { wasmBinaryFile = locateFile(wasmBinaryFile) }
    if (!isDataURI(asmjsCodeFile)) { asmjsCodeFile = locateFile(asmjsCodeFile) }
    var wasmPageSize = 64 * 1024;
    var info = { "global": null, "env": null, "asm2wasm": asm2wasmImports, "parent": Module };
    var exports = null;

    function mergeMemory(newBuffer) {
        var oldBuffer = Module["buffer"];
        if (newBuffer.byteLength < oldBuffer.byteLength) { err("the new buffer in mergeMemory is smaller than the previous one. in native wasm, we should grow memory here") }
        var oldView = new Int8Array(oldBuffer);
        var newView = new Int8Array(newBuffer);
        newView.set(oldView);
        updateGlobalBuffer(newBuffer);
        updateGlobalBufferViews()
    }

    function getBinary() { try { if (Module["wasmBinary"]) { return new Uint8Array(Module["wasmBinary"]) } if (Module["readBinary"]) { return Module["readBinary"](wasmBinaryFile) } else { throw "both async and sync fetching of the wasm failed" } } catch (err) { abort(err) } }

    function getBinaryPromise() { if (!Module["wasmBinary"] && (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) && typeof fetch === "function") { return fetch(wasmBinaryFile, { credentials: "same-origin" }).then((function(response) { if (!response["ok"]) { throw "failed to load wasm binary file at '" + wasmBinaryFile + "'" } return response["arrayBuffer"]() })).catch((function() { return getBinary() })) } return new Promise((function(resolve, reject) { resolve(getBinary()) })) }

    function doNativeWasm(global, env, providedBuffer) {
        if (typeof WebAssembly !== "object") { err("no native wasm support detected"); return false }
        if (!(Module["wasmMemory"] instanceof WebAssembly.Memory)) { err("no native wasm Memory in use"); return false }
        env["memory"] = Module["wasmMemory"];
        info["global"] = { "NaN": NaN, "Infinity": Infinity };
        info["global.Math"] = Math;
        info["env"] = env;

        function receiveInstance(instance, module) {
            exports = instance.exports;
            if (exports.memory) mergeMemory(exports.memory);
            Module["asm"] = exports;
            Module["usingWasm"] = true;
            removeRunDependency("wasm-instantiate")
        }
        addRunDependency("wasm-instantiate");
        if (Module["instantiateWasm"]) { try { return Module["instantiateWasm"](info, receiveInstance) } catch (e) { err("Module.instantiateWasm callback failed with error: " + e); return false } }

        function receiveInstantiatedSource(output) { receiveInstance(output["instance"], output["module"]) }

        function instantiateArrayBuffer(receiver) {
            getBinaryPromise().then((function(binary) { return WebAssembly.instantiate(binary, info) })).then(receiver, (function(reason) {
                err("failed to asynchronously prepare wasm: " + reason);
                abort(reason)
            }))
        }
        if (!Module["wasmBinary"] && typeof WebAssembly.instantiateStreaming === "function" && !isDataURI(wasmBinaryFile) && typeof fetch === "function") {
            WebAssembly.instantiateStreaming(fetch(wasmBinaryFile, { credentials: "same-origin" }), info).then(receiveInstantiatedSource, (function(reason) {
                err("wasm streaming compile failed: " + reason);
                err("falling back to ArrayBuffer instantiation");
                instantiateArrayBuffer(receiveInstantiatedSource)
            }))
        } else { instantiateArrayBuffer(receiveInstantiatedSource) }
        return {}
    }
    Module["asmPreload"] = Module["asm"];
    var asmjsReallocBuffer = Module["reallocBuffer"];
    var wasmReallocBuffer = (function(size) {
        var PAGE_MULTIPLE = Module["usingWasm"] ? WASM_PAGE_SIZE : ASMJS_PAGE_SIZE;
        size = alignUp(size, PAGE_MULTIPLE);
        var old = Module["buffer"];
        var oldSize = old.byteLength;
        if (Module["usingWasm"]) { try { var result = Module["wasmMemory"].grow((size - oldSize) / wasmPageSize); if (result !== (-1 | 0)) { return Module["buffer"] = Module["wasmMemory"].buffer } else { return null } } catch (e) { return null } }
    });
    Module["reallocBuffer"] = (function(size) { if (finalMethod === "asmjs") { return asmjsReallocBuffer(size) } else { return wasmReallocBuffer(size) } });
    var finalMethod = "";
    Module["asm"] = (function(global, env, providedBuffer) {
        if (!env["table"]) {
            var TABLE_SIZE = Module["wasmTableSize"];
            if (TABLE_SIZE === undefined) TABLE_SIZE = 1024;
            var MAX_TABLE_SIZE = Module["wasmMaxTableSize"];
            if (typeof WebAssembly === "object" && typeof WebAssembly.Table === "function") { if (MAX_TABLE_SIZE !== undefined) { env["table"] = new WebAssembly.Table({ "initial": TABLE_SIZE, "maximum": MAX_TABLE_SIZE, "element": "anyfunc" }) } else { env["table"] = new WebAssembly.Table({ "initial": TABLE_SIZE, element: "anyfunc" }) } } else { env["table"] = new Array(TABLE_SIZE) }
            Module["wasmTable"] = env["table"]
        }
        if (!env["__memory_base"]) { env["__memory_base"] = Module["STATIC_BASE"] }
        if (!env["__table_base"]) { env["__table_base"] = 0 }
        var exports;
        exports = doNativeWasm(global, env, providedBuffer);
        assert(exports, "no binaryen method succeeded.");
        return exports
    })
}
integrateWasmJS();
var ASM_CONSTS = [(function() {
    FS.mkdir("/IDBFS");
    FS.mount(IDBFS, {}, "/IDBFS");
    FS.syncfs(true, (function(err) { if (err) console.log("Error while syncing from persistent state to memory", err) }))
}), (function() { FS.syncfs((function(err) { if (err) console.log("Error while syncing from memory to persistent state", err) })) }), (function() { return screen.width }), (function() { return screen.height }), (function($0) { if (typeof Module["setWindowTitle"] !== "undefined") { Module["setWindowTitle"](Module["Pointer_stringify"]($0)) } return 0 }), (function($0, $1, $2) {
    var w = $0;
    var h = $1;
    var pixels = $2;
    if (!Module["SDL2"]) Module["SDL2"] = {};
    var SDL2 = Module["SDL2"];
    if (SDL2.ctxCanvas !== Module["canvas"]) {
        SDL2.ctx = Module["createContext"](Module["canvas"], false, true);
        SDL2.ctxCanvas = Module["canvas"]
    }
    if (SDL2.w !== w || SDL2.h !== h || SDL2.imageCtx !== SDL2.ctx) {
        SDL2.image = SDL2.ctx.createImageData(w, h);
        SDL2.w = w;
        SDL2.h = h;
        SDL2.imageCtx = SDL2.ctx
    }
    var data = SDL2.image.data;
    var src = pixels >> 2;
    var dst = 0;
    var num;
    if (typeof CanvasPixelArray !== "undefined" && data instanceof CanvasPixelArray) {
        num = data.length;
        while (dst < num) {
            var val = HEAP32[src];
            data[dst] = val & 255;
            data[dst + 1] = val >> 8 & 255;
            data[dst + 2] = val >> 16 & 255;
            data[dst + 3] = 255;
            src++;
            dst += 4
        }
    } else {
        if (SDL2.data32Data !== data) {
            SDL2.data32 = new Int32Array(data.buffer);
            SDL2.data8 = new Uint8Array(data.buffer)
        }
        var data32 = SDL2.data32;
        num = data32.length;
        data32.set(HEAP32.subarray(src, src + num));
        var data8 = SDL2.data8;
        var i = 3;
        var j = i + 4 * num;
        if (num % 8 == 0) {
            while (i < j) {
                data8[i] = 255;
                i = i + 4 | 0;
                data8[i] = 255;
                i = i + 4 | 0;
                data8[i] = 255;
                i = i + 4 | 0;
                data8[i] = 255;
                i = i + 4 | 0;
                data8[i] = 255;
                i = i + 4 | 0;
                data8[i] = 255;
                i = i + 4 | 0;
                data8[i] = 255;
                i = i + 4 | 0;
                data8[i] = 255;
                i = i + 4 | 0
            }
        } else {
            while (i < j) {
                data8[i] = 255;
                i = i + 4 | 0
            }
        }
    }
    SDL2.ctx.putImageData(SDL2.image, 0, 0);
    return 0
}), (function($0, $1, $2, $3, $4) {
    var w = $0;
    var h = $1;
    var hot_x = $2;
    var hot_y = $3;
    var pixels = $4;
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    var image = ctx.createImageData(w, h);
    var data = image.data;
    var src = pixels >> 2;
    var dst = 0;
    var num;
    if (typeof CanvasPixelArray !== "undefined" && data instanceof CanvasPixelArray) {
        num = data.length;
        while (dst < num) {
            var val = HEAP32[src];
            data[dst] = val & 255;
            data[dst + 1] = val >> 8 & 255;
            data[dst + 2] = val >> 16 & 255;
            data[dst + 3] = val >> 24 & 255;
            src++;
            dst += 4
        }
    } else {
        var data32 = new Int32Array(data.buffer);
        num = data32.length;
        data32.set(HEAP32.subarray(src, src + num))
    }
    ctx.putImageData(image, 0, 0);
    var url = hot_x === 0 && hot_y === 0 ? "url(" + canvas.toDataURL() + "), auto" : "url(" + canvas.toDataURL() + ") " + hot_x + " " + hot_y + ", auto";
    var urlBuf = _malloc(url.length + 1);
    stringToUTF8(url, urlBuf, url.length + 1);
    return urlBuf
}), (function($0) { if (Module["canvas"]) { Module["canvas"].style["cursor"] = Module["Pointer_stringify"]($0) } return 0 }), (function() { if (Module["canvas"]) { Module["canvas"].style["cursor"] = "none" } }), (function() { if (typeof AudioContext !== "undefined") { return 1 } else if (typeof webkitAudioContext !== "undefined") { return 1 } return 0 }), (function() { if (typeof navigator.mediaDevices !== "undefined" && typeof navigator.mediaDevices.getUserMedia !== "undefined") { return 1 } else if (typeof navigator.webkitGetUserMedia !== "undefined") { return 1 } return 0 }), (function($0) { if (typeof SDL2 === "undefined") { SDL2 = {} } if (!$0) { SDL2.audio = {} } else { SDL2.capture = {} } if (!SDL2.audioContext) { if (typeof AudioContext !== "undefined") { SDL2.audioContext = new AudioContext } else if (typeof webkitAudioContext !== "undefined") { SDL2.audioContext = new webkitAudioContext } } return SDL2.audioContext === undefined ? -1 : 0 }), (function() { return SDL2.audioContext.sampleRate }), (function($0, $1, $2, $3) {
    var have_microphone = (function(stream) {
        if (SDL2.capture.silenceTimer !== undefined) {
            clearTimeout(SDL2.capture.silenceTimer);
            SDL2.capture.silenceTimer = undefined
        }
        SDL2.capture.mediaStreamNode = SDL2.audioContext.createMediaStreamSource(stream);
        SDL2.capture.scriptProcessorNode = SDL2.audioContext.createScriptProcessor($1, $0, 1);
        SDL2.capture.scriptProcessorNode.onaudioprocess = (function(audioProcessingEvent) {
            if (SDL2 === undefined || SDL2.capture === undefined) { return }
            audioProcessingEvent.outputBuffer.getChannelData(0).fill(0);
            SDL2.capture.currentCaptureBuffer = audioProcessingEvent.inputBuffer;
            Runtime.dynCall("vi", $2, [$3])
        });
        SDL2.capture.mediaStreamNode.connect(SDL2.capture.scriptProcessorNode);
        SDL2.capture.scriptProcessorNode.connect(SDL2.audioContext.destination);
        SDL2.capture.stream = stream
    });
    var no_microphone = (function(error) {});
    SDL2.capture.silenceBuffer = SDL2.audioContext.createBuffer($0, $1, SDL2.audioContext.sampleRate);
    SDL2.capture.silenceBuffer.getChannelData(0).fill(0);
    var silence_callback = (function() {
        SDL2.capture.currentCaptureBuffer = SDL2.capture.silenceBuffer;
        Runtime.dynCall("vi", $2, [$3])
    });
    SDL2.capture.silenceTimer = setTimeout(silence_callback, $1 / SDL2.audioContext.sampleRate * 1e3);
    if (navigator.mediaDevices !== undefined && navigator.mediaDevices.getUserMedia !== undefined) { navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(have_microphone).catch(no_microphone) } else if (navigator.webkitGetUserMedia !== undefined) { navigator.webkitGetUserMedia({ audio: true, video: false }, have_microphone, no_microphone) }
}), (function($0, $1, $2, $3) {
    SDL2.audio.scriptProcessorNode = SDL2.audioContext["createScriptProcessor"]($1, 0, $0);
    SDL2.audio.scriptProcessorNode["onaudioprocess"] = (function(e) {
        if (SDL2 === undefined || SDL2.audio === undefined) { return }
        SDL2.audio.currentOutputBuffer = e["outputBuffer"];
        Runtime.dynCall("vi", $2, [$3])
    });
    SDL2.audio.scriptProcessorNode["connect"](SDL2.audioContext["destination"])
}), (function($0) {
    if ($0) {
        if (SDL2.capture.silenceTimer !== undefined) { clearTimeout(SDL2.capture.silenceTimer) }
        if (SDL2.capture.stream !== undefined) {
            var tracks = SDL2.capture.stream.getAudioTracks();
            for (var i = 0; i < tracks.length; i++) { SDL2.capture.stream.removeTrack(tracks[i]) }
            SDL2.capture.stream = undefined
        }
        if (SDL2.capture.scriptProcessorNode !== undefined) {
            SDL2.capture.scriptProcessorNode.onaudioprocess = (function(audioProcessingEvent) {});
            SDL2.capture.scriptProcessorNode.disconnect();
            SDL2.capture.scriptProcessorNode = undefined
        }
        if (SDL2.capture.mediaStreamNode !== undefined) {
            SDL2.capture.mediaStreamNode.disconnect();
            SDL2.capture.mediaStreamNode = undefined
        }
        if (SDL2.capture.silenceBuffer !== undefined) { SDL2.capture.silenceBuffer = undefined }
        SDL2.capture = undefined
    } else {
        if (SDL2.audio.scriptProcessorNode != undefined) {
            SDL2.audio.scriptProcessorNode.disconnect();
            SDL2.audio.scriptProcessorNode = undefined
        }
        SDL2.audio = undefined
    }
    if (SDL2.audioContext !== undefined && SDL2.audio === undefined && SDL2.capture === undefined) {
        SDL2.audioContext.close();
        SDL2.audioContext = undefined
    }
}), (function($0, $1) { var numChannels = SDL2.capture.currentCaptureBuffer.numberOfChannels; for (var c = 0; c < numChannels; ++c) { var channelData = SDL2.capture.currentCaptureBuffer.getChannelData(c); if (channelData.length != $1) { throw "Web Audio capture buffer length mismatch! Destination size: " + channelData.length + " samples vs expected " + $1 + " samples!" } if (numChannels == 1) { for (var j = 0; j < $1; ++j) { setValue($0 + j * 4, channelData[j], "float") } } else { for (var j = 0; j < $1; ++j) { setValue($0 + (j * numChannels + c) * 4, channelData[j], "float") } } } }), (function($0, $1) { var numChannels = SDL2.audio.currentOutputBuffer["numberOfChannels"]; for (var c = 0; c < numChannels; ++c) { var channelData = SDL2.audio.currentOutputBuffer["getChannelData"](c); if (channelData.length != $1) { throw "Web Audio output buffer length mismatch! Destination size: " + channelData.length + " samples vs expected " + $1 + " samples!" } for (var j = 0; j < $1; ++j) { channelData[j] = HEAPF32[$0 + (j * numChannels + c << 2) >> 2] } } })];

function _emscripten_asm_const_i(code) { return ASM_CONSTS[code]() }

function _emscripten_asm_const_iiiii(code, a0, a1, a2, a3) { return ASM_CONSTS[code](a0, a1, a2, a3) }

function _emscripten_asm_const_ii(code, a0) { return ASM_CONSTS[code](a0) }

function _emscripten_asm_const_iii(code, a0, a1) { return ASM_CONSTS[code](a0, a1) }

function _emscripten_asm_const_iiiiii(code, a0, a1, a2, a3, a4) { return ASM_CONSTS[code](a0, a1, a2, a3, a4) }

function _emscripten_asm_const_iiii(code, a0, a1, a2) { return ASM_CONSTS[code](a0, a1, a2) }
STATIC_BASE = GLOBAL_BASE;
STATICTOP = STATIC_BASE + 1109168;
__ATINIT__.push({ func: (function() { ___emscripten_environ_constructor() }) });
var STATIC_BUMP = 1109168;
Module["STATIC_BASE"] = STATIC_BASE;
Module["STATIC_BUMP"] = STATIC_BUMP;
var tempDoublePtr = STATICTOP;
STATICTOP += 16;
var EMTSTACKTOP = getMemory(1048576);
var eb = getMemory(58824);
__ATPRERUN__.push((function() {
    HEAPU8.set([140, 1, 37, 0, 0, 0, 0, 0, 2, 29, 0, 0, 160, 50, 16, 0, 2, 30, 0, 0, 255, 0, 0, 0, 2, 31, 0, 0, 192, 3, 16, 0, 1, 6, 0, 0, 136, 32, 0, 0, 0, 27, 32, 0, 136, 32, 0, 0, 25, 32, 32, 16, 137, 32, 0, 0, 25, 22, 27, 2, 0, 21, 27, 0, 25, 19, 27, 4, 27, 32, 0, 120, 3, 20, 31, 32, 25, 26, 20, 13, 79, 3, 26, 0, 25, 20, 20, 6, 80, 32, 20, 0, 38, 32, 32, 64, 121, 32, 9, 0, 27, 32, 3, 44, 3, 32, 29, 32, 106, 32, 32, 4, 120, 32, 5, 0, 27, 32, 0, 120, 3, 32, 31, 32, 1, 33, 1, 0, 107, 32, 12, 33, 27, 33, 0, 120, 3, 33, 31, 33, 25, 25, 33, 12, 78, 1, 25, 0, 41, 33, 1, 24, 42, 33, 33, 24, 1, 32, 0, 0, 1, 34, 2, 0, 138, 33, 32, 34, 200, 0, 0, 0, 220, 0, 0, 0, 19, 32, 1, 30, 27, 32, 32, 120, 3, 32, 31, 32, 25, 1, 32, 3, 1, 6, 7, 0, 119, 0, 10, 0, 27, 32, 0, 120, 3, 32, 31, 32, 25, 1, 32, 15, 1, 6, 7, 0, 119, 0, 5, 0, 2, 32, 0, 0, 69, 4, 16, 0, 79, 14, 32, 0, 119, 0, 1, 0, 32, 33, 6, 7, 121, 33, 8, 0, 79, 33, 1, 0, 103, 32, 1, 1, 41, 32, 32, 8, 20, 33, 33, 32, 84, 22, 33, 0, 135, 14, 0, 0, 22, 0, 0, 0, 121, 14, 139, 2, 27, 33, 0, 120, 3, 23, 31, 33, 25, 24, 23, 3, 78, 15, 24, 0, 41, 33, 15, 24, 42, 33, 33, 24, 0, 17, 33, 0, 25, 23, 23, 4, 78, 16, 23, 0, 41, 33, 16, 24, 42, 33, 33, 24, 0, 18, 33, 0, 26, 33, 18, 1, 27, 32, 17, 22, 3, 2, 33, 32, 45, 32, 14, 3, 108, 1, 0, 0, 27, 32, 0, 120, 3, 32, 31, 32, 25, 1, 32, 15, 1, 6, 22, 0, 119, 0, 116, 0, 27, 32, 0, 120, 3, 32, 31, 32, 25, 1, 32, 15, 2, 32, 0, 0, 160, 54, 16, 0, 3, 13, 32, 2, 2, 32, 0, 0, 128, 61, 16, 0, 90, 32, 32, 2, 32, 32, 32, 206, 38, 32, 32, 1, 0, 12, 32, 0, 1, 4, 255, 127, 1, 5, 0, 0, 80, 2, 22, 0, 27, 32, 3, 44, 90, 32, 29, 32, 38, 32, 32, 4, 121, 32, 3, 0, 1, 6, 21, 0, 119, 0, 78, 0, 27, 32, 3, 44, 3, 32, 29, 32, 106, 11, 32, 8, 1, 32, 0, 0, 47, 32, 32, 11, 180, 2, 0, 0, 78, 2, 25, 0, 41, 33, 2, 24, 42, 33, 33, 24, 32, 33, 33, 0, 121, 33, 3, 0, 0, 32, 1, 0, 119, 0, 6, 0, 19, 33, 2, 30, 27, 33, 33, 120, 3, 33, 31, 33, 25, 33, 33, 3, 0, 32, 33, 0, 0, 2, 32, 0, 79, 32, 2, 0, 103, 33, 2, 1, 41, 33, 33, 8, 20, 32, 32, 33, 0, 2, 32, 0, 2, 32, 0, 0, 255, 255, 0, 0, 19, 32, 2, 32, 41, 32, 32, 24, 42, 32, 32, 24, 0, 9, 32, 0, 2, 32, 0, 0, 255, 255, 0, 0, 19, 32, 2, 32, 43, 32, 32, 8, 2, 33, 0, 0, 255, 255, 0, 0, 19, 32, 32, 33, 41, 32, 32, 24, 42, 32, 32, 24, 0, 10, 32, 0, 1, 8, 0, 0, 27, 32, 3, 44, 3, 32, 29, 32, 25, 32, 32, 18, 41, 33, 8, 1, 3, 28, 32, 33, 0, 7, 28, 0, 78, 33, 7, 0, 4, 6, 9, 33, 5, 6, 6, 6, 102, 33, 28, 1, 4, 28, 10, 33, 5, 33, 28, 28, 3, 6, 33, 6, 47, 33, 6, 4, 168, 2, 0, 0, 0, 4, 6, 0, 80, 5, 7, 0, 25, 8, 8, 1, 54, 33, 8, 11, 100, 2, 0, 0, 41, 33, 12, 24, 42, 33, 33, 24, 120, 33, 3, 0, 1, 6, 31, 0, 119, 0, 12, 0, 78, 33, 13, 0, 38, 33, 33, 15, 25, 33, 33, 10, 19, 33, 33, 30, 0, 3, 33, 0, 45, 33, 14, 3, 236, 2, 0, 0, 1, 6, 20, 0, 119, 0, 3, 0, 1, 12, 0, 0, 119, 0, 174, 255, 32, 33, 6, 20, 121, 33, 5, 0, 84, 22, 2, 0, 84, 21, 5, 0, 1, 6, 22, 0, 119, 0, 12, 0, 32, 33, 6, 21, 121, 33, 5, 0, 84, 22, 2, 0, 84, 21, 5, 0, 1, 6, 22, 0, 119, 0, 6, 0, 32, 33, 6, 31, 121, 33, 4, 0, 84, 22, 2, 0, 84, 21, 5, 0, 119, 0, 1, 0, 32, 33, 6, 22, 121, 33, 145, 0, 78, 3, 25, 0, 41, 32, 3, 24, 42, 32, 32, 24, 32, 32, 32, 0, 121, 32, 3, 0, 0, 33, 1, 0, 119, 0, 6, 0, 19, 32, 3, 30, 27, 32, 32, 120, 3, 32, 31, 32, 25, 32, 32, 3, 0, 33, 32, 0, 0, 3, 33, 0, 79, 33, 3, 0, 103, 32, 3, 1, 41, 32, 32, 8, 20, 33, 33, 32, 0, 3, 33, 0, 84, 22, 3, 0, 84, 21, 3, 0, 27, 33, 0, 120, 3, 33, 31, 33, 25, 3, 33, 14, 78, 33, 3, 0, 1, 32, 68, 0, 1, 34, 6, 0, 138, 33, 32, 34, 200, 3, 0, 0, 196, 3, 0, 0, 196, 3, 0, 0, 196, 3, 0, 0, 196, 3, 0, 0, 204, 3, 0, 0, 119, 0, 111, 0, 119, 0, 2, 0, 119, 0, 1, 0, 2, 33, 0, 0, 60, 4, 16, 0, 78, 28, 33, 0, 41, 33, 28, 24, 42, 33, 33, 24, 0, 4, 33, 0, 2, 33, 0, 0, 59, 4, 16, 0, 78, 2, 33, 0, 41, 33, 16, 24, 42, 33, 33, 24, 41, 32, 28, 24, 42, 32, 32, 24, 45, 33, 33, 32, 28, 4, 0, 0, 41, 33, 2, 24, 42, 33, 33, 24, 0, 2, 33, 0, 119, 0, 30, 0, 41, 33, 15, 24, 42, 33, 33, 24, 41, 32, 2, 24, 42, 32, 32, 24, 45, 33, 33, 32, 60, 4, 0, 0, 0, 2, 17, 0, 119, 0, 22, 0, 41, 33, 2, 24, 42, 33, 33, 24, 0, 2, 33, 0, 4, 16, 18, 4, 4, 28, 17, 2, 34, 32, 16, 0, 121, 32, 5, 0, 1, 32, 0, 0, 4, 32, 32, 16, 0, 33, 32, 0, 119, 0, 2, 0, 0, 33, 16, 0, 34, 34, 28, 0, 121, 34, 5, 0, 1, 34, 0, 0, 4, 34, 34, 28, 0, 32, 34, 0, 119, 0, 2, 0, 0, 32, 28, 0, 53, 33, 33, 32, 128, 5, 0, 0, 4, 28, 17, 2, 4, 18, 18, 4, 5, 33, 18, 18, 26, 33, 33, 3, 5, 32, 28, 28, 3, 33, 33, 32, 35, 33, 33, 34, 121, 33, 53, 0, 80, 33, 20, 0, 1, 32, 0, 8, 19, 33, 33, 32, 120, 33, 49, 0, 1, 32, 5, 0, 135, 33, 1, 0, 32, 0, 0, 0, 120, 33, 45, 0, 78, 34, 3, 0, 32, 34, 34, 68, 1, 35, 8, 0, 1, 36, 14, 0, 125, 32, 34, 35, 36, 0, 0, 0, 135, 33, 2, 0, 32, 0, 0, 0, 2, 33, 0, 0, 94, 200, 16, 0, 1, 32, 0, 0, 83, 33, 32, 0, 2, 33, 0, 0, 60, 4, 16, 0, 78, 33, 33, 0, 78, 36, 23, 0, 4, 33, 33, 36, 135, 32, 3, 0, 33, 0, 0, 0, 19, 32, 32, 30, 0, 28, 32, 0, 107, 19, 1, 28, 2, 33, 0, 0, 59, 4, 16, 0, 78, 33, 33, 0, 78, 36, 24, 0, 4, 33, 33, 36, 135, 32, 3, 0, 33, 0, 0, 0, 19, 32, 32, 30, 0, 28, 32, 0, 83, 19, 28, 0, 78, 36, 3, 0, 32, 36, 36, 68, 2, 35, 0, 0, 53, 115, 15, 0, 2, 34, 0, 0, 59, 115, 15, 0, 125, 33, 36, 35, 34, 0, 0, 0, 134, 32, 0, 0, 248, 34, 0, 0, 24, 19, 33, 0, 119, 0, 112, 1, 135, 32, 4, 0, 0, 21, 0, 0, 78, 4, 25, 0, 19, 32, 4, 30, 0, 5, 32, 0, 41, 33, 4, 24, 42, 33, 33, 24, 32, 33, 33, 0, 121, 33, 3, 0, 0, 32, 1, 0, 119, 0, 5, 0, 27, 33, 5, 120, 3, 33, 31, 33, 25, 33, 33, 3, 0, 32, 33, 0, 0, 3, 32, 0, 79, 32, 3, 0, 103, 33, 3, 1, 41, 33, 33, 8, 20, 32, 32, 33, 0, 3, 32, 0, 84, 22, 3, 0, 2, 32, 0, 0, 190, 200, 16, 0, 78, 1, 32, 0, 19, 32, 3, 30, 0, 2, 32, 0, 2, 32, 0, 0, 255, 255, 0, 0, 19, 32, 3, 32, 43, 32, 32, 8, 19, 32, 32, 30, 0, 3, 32, 0, 41, 32, 1, 24, 42, 32, 32, 24, 2, 33, 0, 0, 59, 4, 16, 0, 78, 33, 33, 0, 45, 32, 32, 33, 80, 6, 0, 0, 2, 32, 0, 0, 191, 200, 16, 0, 78, 32, 32, 0, 2, 33, 0, 0, 60, 4, 16, 0, 78, 33, 33, 0, 45, 32, 32, 33, 80, 6, 0, 0, 134, 32, 0, 0, 188, 23, 0, 0, 0, 0, 0, 0, 119, 0, 60, 1, 41, 33, 1, 24, 42, 33, 33, 24, 41, 34, 2, 24, 42, 34, 34, 24, 45, 33, 33, 34, 136, 6, 0, 0, 2, 33, 0, 0, 191, 200, 16, 0, 78, 33, 33, 0, 41, 34, 3, 24, 42, 34, 34, 24, 13, 33, 33, 34, 0, 32, 33, 0, 119, 0, 3, 0, 1, 33, 0, 0, 0, 32, 33, 0, 121, 32, 66, 0, 2, 32, 0, 0, 72, 200, 16, 0, 78, 1, 32, 0, 41, 32, 1, 24, 42, 32, 32, 24, 121, 32, 60, 0, 19, 32, 1, 30, 0, 1, 32, 0, 52, 32, 1, 5, 228, 6, 0, 0, 27, 32, 1, 120, 3, 32, 31, 32, 102, 1, 32, 1, 41, 32, 1, 24, 42, 32, 32, 24, 120, 32, 2, 0, 119, 0, 49, 0, 19, 32, 1, 30, 0, 1, 32, 0, 119, 0, 245, 255, 2, 33, 0, 0, 72, 200, 16, 0, 135, 32, 5, 0, 33, 4, 0, 0, 27, 33, 0, 120, 3, 33, 31, 33, 25, 33, 33, 8, 135, 32, 6, 0, 33, 4, 0, 0, 79, 32, 26, 0, 27, 32, 32, 44, 90, 32, 29, 32, 38, 32, 32, 2, 32, 32, 32, 0, 1, 33, 250, 255, 1, 34, 177, 255, 125, 3, 32, 33, 34, 0, 0, 0, 27, 34, 5, 120, 3, 2, 31, 34, 25, 1, 2, 3, 78, 28, 1, 0, 25, 2, 2, 4, 78, 22, 2, 0, 2, 34, 0, 0, 128, 61, 16, 0, 26, 33, 22, 1, 27, 32, 28, 22, 3, 33, 33, 32, 95, 34, 33, 3, 135, 33, 7, 0, 22, 28, 0, 0, 121, 33, 8, 0, 1, 34, 20, 0, 135, 33, 2, 0, 34, 0, 0, 0, 78, 34, 2, 0, 78, 32, 1, 0, 135, 33, 8, 0, 34, 32, 3, 0, 135, 33, 9, 0, 0, 0, 0, 0, 19, 33, 33, 30, 0, 28, 33, 0, 83, 25, 28, 0, 27, 33, 0, 120, 3, 33, 31, 33, 25, 3, 33, 14, 78, 33, 3, 0, 33, 33, 33, 70, 121, 33, 228, 0, 27, 33, 0, 120, 3, 33, 31, 33, 25, 5, 33, 11, 78, 1, 5, 0, 41, 33, 1, 24, 42, 33, 33, 24, 1, 32, 32, 0, 1, 35, 33, 0, 138, 33, 32, 35, 96, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 88, 8, 0, 0, 184, 8, 0, 0, 1, 6, 49, 0, 119, 0, 24, 0, 78, 34, 23, 0, 78, 35, 24, 0, 135, 32, 7, 0, 34, 35, 0, 0, 121, 32, 15, 0, 78, 1, 24, 0, 78, 2, 23, 0, 2, 32, 0, 0, 128, 61, 16, 0, 26, 35, 2, 1, 27, 34, 1, 22, 3, 35, 35, 34, 90, 32, 32, 35, 32, 32, 32, 250, 121, 32, 5, 0, 1, 35, 250, 255, 135, 32, 8, 0, 2, 1, 35, 0, 119, 0, 5, 0, 78, 1, 5, 0, 1, 6, 49, 0, 119, 0, 2, 0, 119, 0, 1, 0, 32, 33, 6, 49, 121, 33, 26, 0, 41, 33, 1, 24, 42, 33, 33, 24, 32, 33, 33, 250, 121, 33, 17, 0, 78, 32, 23, 0, 78, 35, 24, 0, 135, 33, 7, 0, 32, 35, 0, 0, 120, 33, 12, 0, 2, 33, 0, 0, 62, 4, 16, 0, 80, 33, 33, 0, 38, 33, 33, 2, 120, 33, 7, 0, 78, 35, 23, 0, 78, 32, 24, 0, 1, 34, 32, 0, 135, 33, 8, 0, 35, 32, 34, 0, 119, 0, 6, 0, 78, 34, 23, 0, 78, 32, 24, 0, 78, 35, 5, 0, 135, 33, 8, 0, 34, 32, 35, 0, 78, 2, 26, 0, 19, 33, 2, 30, 0, 4, 33, 0, 2, 33, 0, 0, 190, 200, 16, 0, 78, 33, 33, 0, 78, 35, 24, 0, 45, 33, 33, 35, 108, 9, 0, 0, 2, 33, 0, 0, 191, 200, 16, 0, 78, 33, 33, 0, 78, 35, 23, 0, 46, 33, 33, 35, 104, 9, 0, 0, 1, 6, 56, 0, 119, 0, 2, 0, 1, 6, 56, 0, 32, 33, 6, 56, 121, 33, 24, 0, 2, 33, 0, 0, 190, 200, 16, 0, 135, 1, 0, 0, 33, 0, 0, 0, 83, 26, 1, 0, 19, 33, 1, 30, 0, 1, 33, 0, 120, 1, 3, 0, 83, 26, 2, 0, 119, 0, 104, 0, 46, 33, 1, 4, 188, 9, 0, 0, 135, 33, 9, 0, 0, 0, 0, 0, 19, 33, 33, 30, 0, 28, 33, 0, 83, 25, 28, 0, 2, 33, 0, 0, 190, 200, 16, 0, 80, 28, 33, 0, 83, 24, 28, 0, 42, 35, 28, 8, 107, 24, 1, 35, 135, 35, 10, 0, 0, 0, 0, 0, 120, 35, 34, 0, 2, 35, 0, 0, 62, 4, 16, 0, 80, 35, 35, 0, 38, 35, 35, 2, 120, 35, 4, 0, 1, 35, 64, 0, 83, 5, 35, 0, 119, 0, 66, 0, 1, 33, 112, 0, 135, 35, 11, 0, 33, 0, 0, 0, 2, 33, 0, 0, 191, 200, 16, 0, 78, 33, 33, 0, 2, 32, 0, 0, 190, 200, 16, 0, 78, 32, 32, 0, 135, 35, 12, 0, 33, 32, 0, 0, 19, 35, 35, 30, 0, 6, 35, 0, 83, 5, 6, 0, 2, 32, 0, 0, 191, 200, 16, 0, 78, 32, 32, 0, 2, 33, 0, 0, 190, 200, 16, 0, 78, 33, 33, 0, 78, 34, 3, 0, 135, 35, 8, 0, 32, 33, 34, 0, 1, 6, 68, 0, 119, 0, 41, 0, 2, 35, 0, 0, 190, 200, 16, 0, 78, 1, 35, 0, 2, 35, 0, 0, 191, 200, 16, 0, 78, 2, 35, 0, 2, 35, 0, 0, 160, 54, 16, 0, 26, 34, 2, 1, 27, 33, 1, 22, 3, 34, 34, 33, 90, 35, 35, 34, 38, 35, 35, 64, 121, 35, 10, 0, 1, 34, 112, 0, 135, 35, 11, 0, 34, 0, 0, 0, 2, 35, 0, 0, 191, 200, 16, 0, 78, 2, 35, 0, 2, 35, 0, 0, 190, 200, 16, 0, 78, 1, 35, 0, 135, 35, 12, 0, 2, 1, 0, 0, 19, 35, 35, 30, 0, 6, 35, 0, 83, 5, 6, 0, 2, 34, 0, 0, 191, 200, 16, 0, 78, 34, 34, 0, 2, 33, 0, 0, 190, 200, 16, 0, 78, 33, 33, 0, 27, 32, 0, 120, 3, 32, 31, 32, 102, 32, 32, 10, 135, 35, 8, 0, 34, 33, 32, 0, 1, 6, 68, 0, 32, 35, 6, 68, 121, 35, 10, 0, 78, 35, 5, 0, 32, 35, 35, 250, 121, 35, 7, 0, 27, 35, 4, 44, 90, 35, 29, 35, 38, 35, 35, 1, 121, 35, 3, 0, 1, 35, 32, 0, 83, 5, 35, 0, 1, 32, 7, 0, 135, 35, 11, 0, 32, 0, 0, 0, 137, 27, 0, 0, 139, 0, 0, 0, 140, 0, 8, 0, 0, 0, 0, 0, 2, 2, 0, 0, 92, 200, 16, 0, 2, 3, 0, 0, 28, 50, 4, 0, 2, 4, 0, 0, 84, 200, 16, 0, 2, 5, 0, 0, 178, 198, 16, 0, 78, 5, 5, 0, 83, 2, 5, 0, 1, 6, 1, 0, 135, 5, 13, 0, 6, 0, 0, 0, 2, 5, 0, 0, 94, 200, 16, 0, 78, 5, 5, 0, 120, 5, 5, 0, 2, 5, 0, 0, 91, 200, 16, 0, 1, 6, 0, 0, 83, 5, 6, 0, 2, 6, 0, 0, 77, 200, 16, 0, 1, 5, 0, 0, 83, 6, 5, 0, 2, 5, 0, 0, 79, 200, 16, 0, 1, 6, 1, 0, 83, 5, 6, 0, 2, 6, 0, 0, 112, 200, 16, 0, 82, 1, 6, 0, 26, 0, 1, 1, 2, 6, 0, 0, 112, 200, 16, 0, 85, 6, 0, 0, 1, 6, 1, 0, 47, 6, 6, 1, 52, 12, 0, 0, 1, 5, 0, 0, 135, 6, 14, 0, 5, 0, 0, 0, 1, 5, 1, 0, 134, 6, 0, 0, 204, 220, 0, 0, 5, 0, 0, 0, 120, 6, 6, 0, 2, 6, 0, 0, 112, 200, 16, 0, 82, 0, 6, 0, 1, 1, 7, 0, 119, 0, 8, 0, 2, 6, 0, 0, 112, 200, 16, 0, 1, 5, 0, 0, 85, 6, 5, 0, 1, 1, 9, 0, 119, 0, 2, 0, 1, 1, 7, 0, 32, 5, 1, 7, 121, 5, 19, 0, 1, 5, 0, 0, 47, 5, 5, 0, 132, 12, 0, 0, 2, 5, 0, 0, 79, 200, 16, 0, 2, 6, 0, 0, 82, 200, 16, 0, 78, 6, 6, 0, 83, 5, 6, 0, 2, 6, 0, 0, 81, 200, 16, 0, 78, 6, 6, 0, 83, 4, 6, 0, 1, 6, 0, 0, 83, 2, 6, 0, 1, 1, 62, 0, 119, 0, 2, 0, 1, 1, 9, 0, 32, 6, 1, 9, 121, 6, 50, 2, 2, 6, 0, 0, 112, 200, 16, 0, 1, 5, 0, 0, 85, 6, 5, 0, 2, 5, 0, 0, 94, 200, 16, 0, 78, 5, 5, 0, 121, 5, 20, 0, 2, 5, 0, 0, 83, 200, 16, 0, 78, 5, 5, 0, 83, 4, 5, 0, 2, 5, 0, 0, 79, 200, 16, 0, 2, 6, 0, 0, 82, 200, 16, 0, 78, 6, 6, 0, 83, 5, 6, 0, 1, 5, 0, 0, 135, 6, 14, 0, 5, 0, 0, 0, 1, 5, 1, 0, 134, 6, 0, 0, 204, 220, 0, 0, 5, 0, 0, 0, 1, 1, 62, 0, 119, 0, 23, 2, 1, 6, 0, 0, 83, 4, 6, 0, 1, 5, 1, 0, 135, 6, 14, 0, 5, 0, 0, 0, 1, 5, 0, 0, 134, 6, 0, 0, 8, 135, 0, 0, 5, 0, 0, 0, 134, 0, 0, 0, 4, 229, 0, 0, 1, 6, 135, 0, 1, 5, 2, 0, 138, 0, 6, 5, 64, 13, 0, 0, 80, 13, 0, 0, 119, 0, 7, 0, 1, 5, 0, 0, 135, 6, 15, 0, 5, 0, 0, 0, 119, 0, 245, 255, 135, 6, 16, 0, 119, 0, 243, 255, 135, 6, 17, 0, 135, 6, 18, 0, 1, 5, 13, 0, 1, 6, 15, 0, 138, 0, 5, 6, 176, 13, 0, 0, 168, 13, 0, 0, 168, 13, 0, 0, 168, 13, 0, 0, 168, 13, 0, 0, 168, 13, 0, 0, 168, 13, 0, 0, 168, 13, 0, 0, 168, 13, 0, 0, 168, 13, 0, 0, 168, 13, 0, 0, 168, 13, 0, 0, 168, 13, 0, 0, 168, 13, 0, 0, 192, 13, 0, 0, 1, 1, 20, 0, 119, 0, 11, 0, 134, 0, 0, 0, 80, 198, 0, 0, 1, 1, 20, 0, 119, 0, 7, 0, 2, 6, 0, 0, 112, 200, 16, 0, 1, 5, 0, 0, 85, 6, 5, 0, 1, 1, 54, 0, 119, 0, 1, 0, 32, 5, 1, 20, 121, 5, 39, 1, 1, 1, 0, 0, 1, 6, 27, 0, 1, 5, 149, 0, 138, 0, 6, 5, 88, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 96, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 104, 16, 0, 0, 172, 16, 0, 0, 176, 16, 0, 0, 180, 16, 0, 0, 184, 16, 0, 0, 188, 16, 0, 0, 192, 16, 0, 0, 196, 16, 0, 0, 200, 16, 0, 0, 204, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 208, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 36, 17, 0, 0, 60, 17, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 68, 16, 0, 0, 84, 17, 0, 0, 92, 17, 0, 0, 104, 17, 0, 0, 112, 17, 0, 0, 120, 17, 0, 0, 128, 17, 0, 0, 136, 17, 0, 0, 144, 17, 0, 0, 152, 17, 0, 0, 176, 17, 0, 0, 184, 17, 0, 0, 192, 17, 0, 0, 200, 17, 0, 0, 208, 17, 0, 0, 216, 17, 0, 0, 224, 17, 0, 0, 232, 17, 0, 0, 240, 17, 0, 0, 248, 17, 0, 0, 16, 18, 0, 0, 24, 18, 0, 0, 32, 18, 0, 0, 40, 18, 0, 0, 48, 18, 0, 0, 56, 18, 0, 0, 64, 18, 0, 0, 72, 18, 0, 0, 80, 18, 0, 0, 88, 18, 0, 0, 112, 18, 0, 0, 1, 6, 255, 0, 19, 6, 0, 6, 0, 0, 6, 0, 83, 4, 0, 0, 119, 0, 137, 0, 1, 1, 54, 0, 119, 0, 135, 0, 1, 1, 56, 0, 119, 0, 133, 0, 26, 5, 0, 48, 2, 6, 0, 0, 112, 200, 16, 0, 82, 6, 6, 0, 27, 6, 6, 10, 3, 0, 5, 6, 1, 6, 15, 39, 26, 5, 0, 1, 50, 6, 6, 5, 152, 16, 0, 0, 1, 1, 56, 0, 119, 0, 121, 0, 2, 6, 0, 0, 112, 200, 16, 0, 85, 6, 0, 0, 1, 1, 56, 0, 119, 0, 116, 0, 119, 0, 239, 255, 119, 0, 238, 255, 119, 0, 237, 255, 119, 0, 236, 255, 119, 0, 235, 255, 119, 0, 234, 255, 119, 0, 233, 255, 119, 0, 232, 255, 119, 0, 231, 255, 2, 5, 0, 0, 112, 200, 16, 0, 2, 6, 0, 0, 116, 200, 16, 0, 82, 6, 6, 0, 85, 5, 6, 0, 2, 6, 0, 0, 81, 200, 16, 0, 78, 0, 6, 0, 83, 4, 0, 0, 2, 6, 0, 0, 79, 200, 16, 0, 2, 5, 0, 0, 82, 200, 16, 0, 78, 5, 5, 0, 83, 6, 5, 0, 2, 5, 0, 0, 77, 200, 16, 0, 1, 6, 1, 0, 83, 5, 6, 0, 119, 0, 86, 0, 78, 6, 2, 0, 32, 6, 6, 0, 38, 6, 6, 1, 83, 2, 6, 0, 1, 1, 56, 0, 119, 0, 80, 0, 2, 6, 0, 0, 79, 200, 16, 0, 1, 5, 0, 0, 83, 6, 5, 0, 1, 1, 56, 0, 119, 0, 74, 0, 1, 1, 58, 0, 119, 0, 90, 0, 1, 0, 107, 0, 1, 1, 59, 0, 119, 0, 87, 0, 1, 1, 23, 0, 119, 0, 85, 0, 1, 1, 24, 0, 119, 0, 83, 0, 1, 1, 25, 0, 119, 0, 81, 0, 1, 1, 26, 0, 119, 0, 79, 0, 1, 1, 27, 0, 119, 0, 77, 0, 1, 1, 28, 0, 119, 0, 75, 0, 78, 6, 2, 0, 32, 6, 6, 0, 38, 6, 6, 1, 83, 2, 6, 0, 1, 1, 56, 0, 119, 0, 51, 0, 1, 1, 30, 0, 119, 0, 67, 0, 1, 1, 31, 0, 119, 0, 65, 0, 1, 1, 32, 0, 119, 0, 63, 0, 1, 1, 33, 0, 119, 0, 61, 0, 1, 1, 34, 0, 119, 0, 59, 0, 1, 1, 35, 0, 119, 0, 57, 0, 1, 1, 36, 0, 119, 0, 55, 0, 1, 1, 37, 0, 119, 0, 53, 0, 1, 1, 38, 0, 119, 0, 51, 0, 78, 6, 2, 0, 32, 6, 6, 0, 38, 6, 6, 1, 83, 2, 6, 0, 1, 1, 56, 0, 119, 0, 27, 0, 1, 1, 40, 0, 119, 0, 43, 0, 1, 1, 41, 0, 119, 0, 41, 0, 1, 1, 42, 0, 119, 0, 39, 0, 1, 1, 43, 0, 119, 0, 37, 0, 1, 1, 44, 0, 119, 0, 35, 0, 1, 1, 45, 0, 119, 0, 33, 0, 1, 1, 46, 0, 119, 0, 31, 0, 1, 1, 47, 0, 119, 0, 29, 0, 1, 1, 48, 0, 119, 0, 27, 0, 78, 6, 2, 0, 32, 6, 6, 0, 38, 6, 6, 1, 83, 2, 6, 0, 1, 1, 56, 0, 119, 0, 3, 0, 1, 1, 50, 0, 119, 0, 19, 0, 32, 6, 1, 54, 121, 6, 10, 0, 2, 6, 0, 0, 91, 200, 16, 0, 1, 5, 0, 0, 83, 6, 5, 0, 2, 5, 0, 0, 112, 200, 16, 0, 1, 6, 0, 0, 85, 5, 6, 0, 1, 1, 56, 0, 32, 6, 1, 56, 121, 6, 3, 0, 1, 1, 0, 0, 78, 0, 4, 0, 41, 6, 0, 24, 42, 6, 6, 24, 121, 6, 146, 254, 1, 6, 23, 0, 1, 5, 36, 0, 138, 1, 6, 5, 96, 19, 0, 0, 108, 19, 0, 0, 120, 19, 0, 0, 132, 19, 0, 0, 144, 19, 0, 0, 156, 19, 0, 0, 92, 19, 0, 0, 168, 19, 0, 0, 180, 19, 0, 0, 192, 19, 0, 0, 204, 19, 0, 0, 216, 19, 0, 0, 228, 19, 0, 0, 240, 19, 0, 0, 252, 19, 0, 0, 8, 20, 0, 0, 92, 19, 0, 0, 20, 20, 0, 0, 32, 20, 0, 0, 60, 20, 0, 0, 88, 20, 0, 0, 116, 20, 0, 0, 144, 20, 0, 0, 172, 20, 0, 0, 200, 20, 0, 0, 228, 20, 0, 0, 92, 19, 0, 0, 0, 21, 0, 0, 92, 19, 0, 0, 92, 19, 0, 0, 92, 19, 0, 0, 92, 19, 0, 0, 92, 19, 0, 0, 92, 19, 0, 0, 92, 19, 0, 0, 12, 21, 0, 0, 119, 0, 111, 0, 1, 0, 117, 0, 1, 1, 59, 0, 119, 0, 108, 0, 1, 0, 104, 0, 1, 1, 59, 0, 119, 0, 105, 0, 1, 0, 108, 0, 1, 1, 59, 0, 119, 0, 102, 0, 1, 0, 98, 0, 1, 1, 59, 0, 119, 0, 99, 0, 1, 0, 106, 0, 1, 1, 59, 0, 119, 0, 96, 0, 1, 0, 110, 0, 1, 1, 59, 0, 119, 0, 93, 0, 1, 0, 115, 0, 1, 1, 59, 0, 119, 0, 90, 0, 1, 0, 89, 0, 1, 1, 59, 0, 119, 0, 87, 0, 1, 0, 75, 0, 1, 1, 59, 0, 119, 0, 84, 0, 1, 0, 85, 0, 1, 1, 59, 0, 119, 0, 81, 0, 1, 0, 72, 0, 1, 1, 59, 0, 119, 0, 78, 0, 1, 0, 76, 0, 1, 1, 59, 0, 119, 0, 75, 0, 1, 0, 66, 0, 1, 1, 59, 0, 119, 0, 72, 0, 1, 0, 74, 0, 1, 1, 59, 0, 119, 0, 69, 0, 1, 0, 78, 0, 1, 1, 59, 0, 119, 0, 66, 0, 1, 0, 115, 0, 1, 1, 59, 0, 119, 0, 63, 0, 78, 6, 2, 0, 32, 6, 6, 0, 38, 6, 6, 1, 83, 2, 6, 0, 1, 0, 121, 0, 1, 1, 59, 0, 119, 0, 56, 0, 78, 6, 2, 0, 32, 6, 6, 0, 38, 6, 6, 1, 83, 2, 6, 0, 1, 0, 107, 0, 1, 1, 59, 0, 119, 0, 49, 0, 78, 6, 2, 0, 32, 6, 6, 0, 38, 6, 6, 1, 83, 2, 6, 0, 1, 0, 117, 0, 1, 1, 59, 0, 119, 0, 42, 0, 78, 6, 2, 0, 32, 6, 6, 0, 38, 6, 6, 1, 83, 2, 6, 0, 1, 0, 104, 0, 1, 1, 59, 0, 119, 0, 35, 0, 78, 6, 2, 0, 32, 6, 6, 0, 38, 6, 6, 1, 83, 2, 6, 0, 1, 0, 108, 0, 1, 1, 59, 0, 119, 0, 28, 0, 78, 6, 2, 0, 32, 6, 6, 0, 38, 6, 6, 1, 83, 2, 6, 0, 1, 0, 98, 0, 1, 1, 59, 0, 119, 0, 21, 0, 78, 6, 2, 0, 32, 6, 6, 0, 38, 6, 6, 1, 83, 2, 6, 0, 1, 0, 106, 0, 1, 1, 59, 0, 119, 0, 14, 0, 78, 6, 2, 0, 32, 6, 6, 0, 38, 6, 6, 1, 83, 2, 6, 0, 1, 0, 110, 0, 1, 1, 59, 0, 119, 0, 7, 0, 1, 0, 115, 0, 1, 1, 59, 0, 119, 0, 4, 0, 1, 0, 121, 0, 1, 1, 59, 0, 119, 0, 1, 0, 32, 6, 1, 59, 121, 6, 2, 0, 83, 4, 0, 0, 2, 6, 0, 0, 77, 200, 16, 0, 78, 6, 6, 0, 120, 6, 8, 0, 2, 6, 0, 0, 112, 200, 16, 0, 82, 0, 6, 0, 2, 6, 0, 0, 116, 200, 16, 0, 85, 6, 0, 0, 119, 0, 2, 0, 1, 1, 62, 0, 32, 6, 1, 62, 121, 6, 4, 0, 2, 6, 0, 0, 112, 200, 16, 0, 82, 0, 6, 0, 121, 0, 3, 0, 1, 6, 0, 0, 83, 2, 6, 0, 78, 0, 4, 0, 41, 6, 0, 24, 42, 6, 6, 24, 1, 7, 46, 0, 1, 5, 76, 0, 138, 6, 7, 5, 208, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 212, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 216, 22, 0, 0, 188, 22, 0, 0, 220, 22, 0, 0, 224, 22, 0, 0, 228, 22, 0, 0, 188, 22, 0, 0, 232, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 236, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 240, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 244, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 248, 22, 0, 0, 188, 22, 0, 0, 112, 23, 0, 0, 116, 23, 0, 0, 120, 23, 0, 0, 188, 22, 0, 0, 124, 23, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 128, 23, 0, 0, 188, 22, 0, 0, 132, 23, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 188, 22, 0, 0, 136, 23, 0, 0, 2, 5, 0, 0, 112, 200, 16, 0, 1, 7, 0, 0, 85, 5, 7, 0, 119, 0, 48, 0, 119, 0, 47, 0, 119, 0, 46, 0, 119, 0, 45, 0, 119, 0, 44, 0, 119, 0, 43, 0, 119, 0, 42, 0, 119, 0, 41, 0, 119, 0, 40, 0, 119, 0, 39, 0, 119, 0, 1, 0, 78, 5, 2, 0, 32, 5, 5, 0, 2, 7, 0, 0, 94, 200, 16, 0, 78, 7, 7, 0, 33, 7, 7, 0, 20, 5, 5, 7, 120, 5, 30, 0, 2, 5, 0, 0, 62, 4, 16, 0, 80, 5, 5, 0, 38, 5, 5, 1, 120, 5, 9, 0, 2, 5, 0, 0, 91, 200, 16, 0, 1, 7, 1, 0, 83, 5, 7, 0, 2, 7, 0, 0, 93, 200, 16, 0, 1, 5, 1, 0, 83, 7, 5, 0, 1, 7, 255, 0, 19, 7, 0, 7, 135, 5, 19, 0, 7, 0, 0, 0, 1, 7, 255, 0, 19, 5, 5, 7, 0, 0, 5, 0, 83, 4, 0, 0, 119, 0, 8, 0, 119, 0, 226, 255, 119, 0, 225, 255, 119, 0, 224, 255, 119, 0, 223, 255, 119, 0, 3, 0, 119, 0, 221, 255, 119, 0, 220, 255, 2, 6, 0, 0, 81, 200, 16, 0, 83, 6, 0, 0, 2, 6, 0, 0, 82, 200, 16, 0, 2, 7, 0, 0, 79, 200, 16, 0, 78, 7, 7, 0, 83, 6, 7, 0, 1, 7, 255, 0, 19, 7, 0, 7, 139, 7, 0, 0, 140, 1, 23, 0, 0, 0, 0, 0, 2, 16, 0, 0, 192, 3, 16, 0, 2, 17, 0, 0, 255, 0, 0, 0, 2, 18, 0, 0, 100, 200, 16, 0, 1, 13, 0, 0, 136, 19, 0, 0, 0, 14, 19, 0, 136, 19, 0, 0, 25, 19, 19, 80, 137, 19, 0, 0, 25, 12, 14, 64, 25, 11, 14, 56, 25, 4, 14, 48, 25, 3, 14, 40, 25, 8, 14, 32, 25, 6, 14, 24, 25, 5, 14, 16, 25, 10, 14, 8, 0, 9, 14, 0, 2, 19, 0, 0, 94, 200, 16, 0, 1, 20, 0, 0, 83, 19, 20, 0, 2, 20, 0, 0, 168, 200, 16, 0, 1, 19, 0, 0, 85, 20, 19, 0, 2, 19, 0, 0, 112, 200, 16, 0, 1, 20, 0, 0, 85, 19, 20, 0, 27, 20, 0, 120, 3, 20, 16, 20, 25, 7, 20, 14, 78, 1, 7, 0, 2, 20, 0, 0, 62, 4, 16, 0, 80, 20, 20, 0, 38, 20, 20, 1, 0, 2, 20, 0, 41, 20, 1, 24, 42, 20, 20, 24, 32, 20, 20, 88, 121, 20, 16, 0, 41, 20, 2, 16, 42, 20, 20, 16, 120, 20, 10, 0, 27, 20, 0, 120, 3, 20, 16, 20, 1, 19, 88, 0, 107, 20, 10, 19, 41, 19, 1, 24, 42, 19, 19, 24, 0, 1, 19, 0, 1, 13, 5, 0, 119, 0, 14, 0, 2, 2, 0, 0, 65, 115, 15, 0, 119, 0, 11, 0, 41, 19, 2, 16, 42, 19, 19, 16, 120, 19, 6, 0, 41, 19, 1, 24, 42, 19, 19, 24, 0, 1, 19, 0, 1, 13, 5, 0, 119, 0, 3, 0, 2, 2, 0, 0, 65, 115, 15, 0, 32, 19, 13, 5, 121, 19, 6, 0, 2, 19, 0, 0, 240, 232, 14, 0, 26, 20, 1, 65, 27, 20, 20, 68, 94, 2, 19, 20, 1, 20, 1, 0, 1, 21, 0, 0, 1, 22, 0, 0, 135, 19, 20, 0, 0, 20, 21, 22, 32, 15, 19, 0, 78, 1, 7, 0, 121, 15, 42, 0, 41, 19, 1, 24, 42, 19, 19, 24, 1, 21, 70, 0, 1, 22, 4, 0, 138, 19, 21, 22, 68, 25, 0, 0, 64, 25, 0, 0, 64, 25, 0, 0, 152, 25, 0, 0, 119, 0, 24, 0, 2, 22, 0, 0, 92, 4, 16, 0, 82, 22, 22, 0, 2, 21, 0, 0, 164, 200, 16, 0, 82, 21, 21, 0, 4, 15, 22, 21, 2, 21, 0, 0, 92, 4, 16, 0, 85, 21, 15, 0, 34, 21, 15, 1, 121, 21, 12, 0, 1, 22, 70, 0, 134, 21, 0, 0, 120, 137, 0, 0, 22, 0, 0, 0, 2, 21, 0, 0, 74, 200, 16, 0, 78, 21, 21, 0, 121, 21, 4, 0, 119, 0, 81, 2, 1, 13, 77, 0, 119, 0, 79, 2, 1, 21, 18, 0, 135, 19, 2, 0, 21, 0, 0, 0, 1, 21, 0, 0, 135, 19, 21, 0, 2, 21, 0, 0, 1, 13, 77, 0, 119, 0, 71, 2, 41, 19, 1, 24, 42, 19, 19, 24, 1, 21, 65, 0, 1, 22, 18, 0, 138, 19, 21, 22, 44, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 28, 26, 0, 0, 60, 26, 0, 0, 1, 22, 12, 0, 135, 21, 2, 0, 22, 0, 0, 0, 119, 0, 9, 0, 1, 22, 27, 0, 135, 21, 2, 0, 22, 0, 0, 0, 119, 0, 5, 0, 1, 22, 3, 0, 135, 21, 2, 0, 22, 0, 0, 0, 119, 0, 1, 0, 1, 21, 0, 0, 135, 19, 22, 0, 2, 21, 0, 0, 2, 19, 0, 0, 92, 4, 16, 0, 82, 19, 19, 0, 34, 19, 19, 1, 121, 19, 9, 0, 78, 21, 7, 0, 134, 19, 0, 0, 120, 137, 0, 0, 21, 0, 0, 0, 2, 19, 0, 0, 74, 200, 16, 0, 78, 19, 19, 0, 120, 19, 20, 2, 27, 19, 0, 120, 3, 19, 16, 19, 104, 19, 19, 6, 1, 21, 0, 8, 19, 19, 19, 21, 120, 19, 13, 2, 78, 19, 7, 0, 1, 20, 65, 0, 1, 21, 23, 0, 138, 19, 20, 21, 24, 27, 0, 0, 16, 27, 0, 0, 16, 27, 0, 0, 16, 27, 0, 0, 16, 27, 0, 0, 80, 28, 0, 0, 16, 27, 0, 0, 16, 27, 0, 0, 180, 28, 0, 0, 16, 27, 0, 0, 16, 27, 0, 0, 232, 28, 0, 0, 16, 27, 0, 0, 124, 30, 0, 0, 16, 27, 0, 0, 16, 27, 0, 0, 16, 27, 0, 0, 76, 32, 0, 0, 16, 27, 0, 0, 16, 27, 0, 0, 16, 27, 0, 0, 60, 33, 0, 0, 64, 33, 0, 0, 1, 13, 77, 0, 119, 0, 241, 1, 2, 21, 0, 0, 97, 200, 16, 0, 78, 1, 21, 0, 41, 21, 1, 24, 42, 21, 21, 24, 120, 21, 3, 0, 1, 13, 77, 0, 119, 0, 233, 1, 19, 21, 1, 17, 0, 1, 21, 0, 27, 21, 1, 120, 3, 21, 16, 21, 25, 2, 21, 116, 82, 3, 2, 0, 1, 21, 9, 0, 49, 21, 21, 3, 100, 27, 0, 0, 1, 13, 77, 0, 119, 0, 222, 1, 27, 21, 1, 120, 3, 21, 16, 21, 102, 21, 21, 79, 120, 21, 3, 0, 1, 13, 77, 0, 119, 0, 216, 1, 2, 21, 0, 0, 99, 200, 16, 0, 78, 1, 21, 0, 41, 21, 1, 24, 42, 21, 21, 24, 120, 21, 3, 0, 1, 13, 20, 0, 119, 0, 8, 0, 19, 21, 1, 17, 27, 21, 21, 120, 3, 21, 16, 21, 102, 21, 21, 79, 33, 21, 21, 13, 121, 21, 2, 0, 1, 13, 20, 0, 32, 21, 13, 20, 121, 21, 25, 0, 78, 1, 18, 0, 41, 21, 1, 24, 42, 21, 21, 24, 121, 21, 7, 0, 19, 21, 1, 17, 27, 21, 21, 120, 3, 21, 16, 21, 102, 21, 21, 79, 32, 21, 21, 13, 120, 21, 15, 0, 25, 21, 3, 1, 85, 2, 21, 0, 2, 21, 0, 0, 177, 198, 16, 0, 78, 21, 21, 0, 121, 21, 3, 0, 1, 13, 77, 0, 119, 0, 181, 1, 2, 22, 0, 0, 97, 115, 15, 0, 135, 21, 23, 0, 22, 10, 0, 0, 1, 13, 77, 0, 119, 0, 175, 1, 2, 21, 0, 0, 177, 198, 16, 0, 78, 21, 21, 0, 121, 21, 3, 0, 1, 13, 77, 0, 119, 0, 169, 1, 2, 22, 0, 0, 68, 115, 15, 0, 135, 21, 23, 0, 22, 9, 0, 0, 1, 13, 77, 0, 119, 0, 163, 1, 2, 22, 0, 0, 62, 4, 16, 0, 2, 20, 0, 0, 62, 4, 16, 0, 80, 20, 20, 0, 1, 21, 128, 0, 20, 20, 20, 21, 84, 22, 20, 0, 2, 20, 0, 0, 164, 200, 16, 0, 82, 20, 20, 0, 25, 13, 20, 1, 2, 20, 0, 0, 164, 200, 16, 0, 85, 20, 13, 0, 85, 3, 13, 0, 27, 22, 0, 120, 3, 22, 16, 22, 25, 22, 22, 40, 2, 21, 0, 0, 231, 115, 15, 0, 135, 20, 24, 0, 22, 21, 3, 0, 1, 13, 77, 0, 119, 0, 138, 1, 2, 21, 0, 0, 148, 200, 16, 0, 82, 1, 21, 0, 36, 21, 1, 1, 121, 21, 3, 0, 1, 13, 77, 0, 119, 0, 131, 1, 2, 21, 0, 0, 148, 200, 16, 0, 26, 22, 1, 1, 85, 21, 22, 0, 1, 13, 77, 0, 119, 0, 125, 1, 2, 20, 0, 0, 140, 200, 16, 0, 82, 1, 20, 0, 2, 20, 0, 0, 136, 200, 16, 0, 82, 20, 20, 0, 27, 20, 20, 10, 25, 20, 20, 50, 135, 15, 1, 0, 20, 0, 0, 0, 2, 20, 0, 0, 140, 200, 16, 0, 1, 21, 254, 255, 4, 21, 21, 15, 2, 22, 0, 0, 140, 200, 16, 0, 82, 22, 22, 0, 3, 21, 21, 22, 85, 20, 21, 0, 1, 20, 3, 0, 135, 21, 25, 0, 20, 0, 0, 0, 120, 21, 42, 0, 2, 21, 0, 0, 136, 200, 16, 0, 82, 21, 21, 0, 27, 21, 21, 10, 25, 21, 21, 50, 135, 12, 1, 0, 21, 0, 0, 0, 2, 21, 0, 0, 136, 200, 16, 0, 82, 21, 21, 0, 27, 21, 21, 10, 25, 21, 21, 50, 135, 13, 1, 0, 21, 0, 0, 0, 2, 21, 0, 0, 136, 200, 16, 0, 82, 21, 21, 0, 27, 21, 21, 10, 25, 21, 21, 50, 135, 15, 1, 0, 21, 0, 0, 0, 2, 21, 0, 0, 136, 200, 16, 0, 82, 21, 21, 0, 27, 21, 21, 10, 25, 21, 21, 50, 135, 2, 1, 0, 21, 0, 0, 0, 1, 21, 248, 255, 4, 21, 21, 12, 4, 21, 21, 13, 4, 21, 21, 15, 4, 21, 21, 2, 2, 20, 0, 0, 140, 200, 16, 0, 82, 20, 20, 0, 3, 2, 21, 20, 2, 20, 0, 0, 140, 200, 16, 0, 85, 20, 2, 0, 119, 0, 4, 0, 2, 20, 0, 0, 140, 200, 16, 0, 82, 2, 20, 0, 34, 20, 2, 0, 121, 20, 5, 0, 2, 20, 0, 0, 140, 200, 16, 0, 1, 21, 0, 0, 85, 20, 21, 0, 27, 20, 0, 120, 3, 20, 16, 20, 25, 20, 20, 3, 1, 22, 0, 0, 135, 21, 26, 0, 20, 0, 22, 0, 2, 21, 0, 0, 140, 200, 16, 0, 82, 21, 21, 0, 45, 21, 21, 1, 64, 30, 0, 0, 1, 13, 77, 0, 119, 0, 39, 1, 1, 22, 11, 0, 135, 21, 2, 0, 22, 0, 0, 0, 2, 21, 0, 0, 177, 198, 16, 0, 78, 21, 21, 0, 121, 21, 3, 0, 1, 13, 77, 0, 119, 0, 30, 1, 2, 22, 0, 0, 236, 115, 15, 0, 135, 21, 23, 0, 22, 4, 0, 0, 1, 13, 77, 0, 119, 0, 24, 1, 2, 21, 0, 0, 64, 4, 16, 0, 78, 1, 21, 0, 41, 21, 1, 24, 42, 21, 21, 24, 120, 21, 3, 0, 1, 13, 77, 0, 119, 0, 16, 1, 1, 4, 0, 0, 19, 21, 1, 17, 0, 3, 21, 0, 1, 1, 0, 0, 2, 21, 0, 0, 97, 200, 16, 0, 79, 21, 21, 0, 46, 21, 3, 21, 28, 31, 0, 0, 2, 21, 0, 0, 98, 200, 16, 0, 79, 21, 21, 0, 46, 21, 3, 21, 28, 31, 0, 0, 2, 21, 0, 0, 99, 200, 16, 0, 79, 21, 21, 0, 46, 21, 3, 21, 28, 31, 0, 0, 79, 21, 18, 0, 46, 21, 3, 21, 28, 31, 0, 0, 25, 2, 1, 1, 135, 21, 27, 0, 3, 0, 0, 0, 121, 21, 7, 0, 135, 21, 1, 0, 2, 0, 0, 0, 32, 15, 21, 0, 0, 1, 2, 0, 125, 4, 15, 3, 4, 0, 0, 0, 27, 21, 3, 120, 3, 21, 16, 21, 102, 2, 21, 1, 41, 21, 2, 24, 42, 21, 21, 24, 120, 21, 2, 0, 119, 0, 4, 0, 19, 21, 2, 17, 0, 3, 21, 0, 119, 0, 219, 255, 120, 4, 3, 0, 1, 13, 77, 0, 119, 0, 227, 0, 27, 22, 0, 120, 3, 22, 16, 22, 25, 22, 22, 3, 1, 20, 0, 0, 135, 21, 26, 0, 22, 0, 20, 0, 1, 20, 20, 0, 135, 21, 2, 0, 20, 0, 0, 0, 27, 21, 4, 120, 3, 21, 16, 21, 25, 1, 21, 100, 82, 2, 1, 0, 1, 21, 1, 0, 47, 21, 21, 2, 224, 31, 0, 0, 27, 21, 4, 120, 3, 21, 16, 21, 106, 21, 21, 112, 120, 21, 17, 0, 1, 21, 1, 0, 85, 1, 21, 0, 1, 20, 1, 0, 135, 21, 28, 0, 4, 20, 0, 0, 2, 21, 0, 0, 242, 200, 16, 0, 85, 11, 21, 0, 2, 20, 0, 0, 6, 116, 15, 0, 135, 21, 23, 0, 20, 11, 0, 0, 26, 21, 2, 1, 85, 1, 21, 0, 1, 13, 77, 0, 119, 0, 191, 0, 2, 21, 0, 0, 152, 200, 16, 0, 2, 20, 0, 0, 152, 200, 16, 0, 82, 20, 20, 0, 26, 20, 20, 1, 85, 21, 20, 0, 19, 20, 4, 17, 0, 13, 20, 0, 2, 21, 0, 0, 64, 4, 16, 0, 135, 20, 5, 0, 21, 13, 0, 0, 135, 20, 29, 0, 13, 0, 0, 0, 1, 21, 1, 0, 135, 20, 28, 0, 4, 21, 0, 0, 2, 20, 0, 0, 242, 200, 16, 0, 85, 12, 20, 0, 2, 21, 0, 0, 6, 116, 15, 0, 135, 20, 23, 0, 21, 12, 0, 0, 1, 13, 77, 0, 119, 0, 164, 0, 1, 21, 0, 0, 135, 22, 25, 0, 21, 0, 0, 0, 121, 22, 3, 0, 1, 13, 77, 0, 119, 0, 158, 0, 2, 22, 0, 0, 99, 200, 16, 0, 78, 1, 22, 0, 41, 22, 1, 24, 42, 22, 22, 24, 120, 22, 3, 0, 1, 13, 31, 0, 119, 0, 8, 0, 19, 22, 1, 17, 27, 22, 22, 120, 3, 22, 16, 22, 102, 22, 22, 79, 33, 22, 22, 2, 121, 22, 2, 0, 1, 13, 31, 0, 32, 22, 13, 31, 121, 22, 26, 0, 78, 1, 18, 0, 41, 22, 1, 24, 42, 22, 22, 24, 121, 22, 7, 0, 19, 22, 1, 17, 27, 22, 22, 120, 3, 22, 16, 22, 102, 22, 22, 79, 32, 22, 22, 2, 120, 22, 16, 0, 1, 21, 255, 255, 135, 22, 30, 0, 21, 0, 0, 0, 2, 22, 0, 0, 177, 198, 16, 0, 78, 22, 22, 0, 121, 22, 3, 0, 1, 13, 77, 0, 119, 0, 122, 0, 2, 21, 0, 0, 124, 115, 15, 0, 135, 22, 23, 0, 21, 5, 0, 0, 1, 13, 77, 0, 119, 0, 116, 0, 2, 22, 0, 0, 177, 198, 16, 0, 78, 22, 22, 0, 121, 22, 3, 0, 1, 13, 77, 0, 119, 0, 110, 0, 2, 21, 0, 0, 173, 115, 15, 0, 135, 22, 23, 0, 21, 6, 0, 0, 1, 13, 77, 0, 119, 0, 104, 0, 119, 0, 1, 0, 1, 22, 100, 0, 135, 15, 1, 0, 22, 0, 0, 0, 78, 22, 7, 0, 32, 1, 22, 87, 1, 21, 15, 0, 1, 20, 30, 0, 125, 22, 1, 21, 20, 0, 0, 0, 49, 22, 22, 15, 116, 33, 0, 0, 1, 13, 77, 0, 119, 0, 90, 0, 121, 1, 42, 0, 2, 22, 0, 0, 80, 4, 16, 0, 82, 22, 22, 0, 120, 22, 9, 0, 1, 20, 87, 0, 134, 22, 0, 0, 120, 137, 0, 0, 20, 0, 0, 0, 2, 22, 0, 0, 74, 200, 16, 0, 78, 22, 22, 0, 120, 22, 77, 0, 2, 22, 0, 0, 84, 4, 16, 0, 82, 1, 22, 0, 26, 15, 1, 1, 2, 22, 0, 0, 84, 4, 16, 0, 85, 22, 15, 0, 120, 15, 11, 0, 2, 22, 0, 0, 80, 4, 16, 0, 1, 20, 0, 0, 85, 22, 20, 0, 2, 20, 0, 0, 84, 4, 16, 0, 1, 22, 1, 0, 85, 20, 22, 0, 1, 1, 10, 0, 119, 0, 13, 0, 2, 22, 0, 0, 80, 4, 16, 0, 2, 20, 0, 0, 64, 244, 14, 0, 26, 21, 1, 2, 41, 21, 21, 2, 94, 20, 20, 21, 25, 20, 20, 1, 85, 22, 20, 0, 1, 1, 10, 0, 119, 0, 2, 0, 1, 1, 5, 0, 1, 20, 1, 0, 135, 1, 31, 0, 20, 1, 0, 0, 2, 20, 0, 0, 92, 4, 16, 0, 82, 20, 20, 0, 4, 15, 20, 1, 2, 20, 0, 0, 92, 4, 16, 0, 85, 20, 15, 0, 2, 20, 0, 0, 128, 4, 16, 0, 82, 20, 20, 0, 4, 1, 20, 1, 2, 20, 0, 0, 128, 4, 16, 0, 85, 20, 1, 0, 34, 20, 15, 1, 121, 20, 5, 0, 2, 20, 0, 0, 92, 4, 16, 0, 1, 22, 1, 0, 85, 20, 22, 0, 34, 22, 1, 1, 121, 22, 9, 0, 78, 20, 7, 0, 134, 22, 0, 0, 120, 137, 0, 0, 20, 0, 0, 0, 2, 22, 0, 0, 74, 200, 16, 0, 78, 22, 22, 0, 120, 22, 14, 0, 2, 22, 0, 0, 177, 198, 16, 0, 78, 22, 22, 0, 121, 22, 3, 0, 1, 13, 77, 0, 119, 0, 8, 0, 2, 20, 0, 0, 205, 115, 15, 0, 135, 22, 23, 0, 20, 8, 0, 0, 1, 13, 77, 0, 119, 0, 2, 0, 1, 13, 77, 0, 32, 19, 13, 77, 121, 19, 5, 0, 2, 19, 0, 0, 112, 200, 16, 0, 1, 20, 0, 0, 85, 19, 20, 0, 137, 14, 0, 0, 139, 0, 0, 0, 140, 3, 42, 0, 0, 0, 0, 0, 2, 34, 0, 0, 74, 200, 16, 0, 2, 35, 0, 0, 192, 3, 16, 0, 2, 36, 0, 0, 255, 0, 0, 0, 2, 37, 0, 0, 37, 50, 4, 0, 1, 31, 0, 0, 136, 38, 0, 0, 0, 33, 38, 0, 136, 38, 0, 0, 25, 38, 38, 96, 137, 38, 0, 0, 25, 27, 33, 80, 25, 30, 33, 72, 25, 29, 33, 64, 25, 28, 33, 56, 25, 26, 33, 48, 25, 25, 33, 40, 25, 24, 33, 84, 0, 32, 33, 0, 2, 39, 0, 0, 53, 115, 15, 0, 135, 38, 32, 0, 2, 39, 0, 0, 120, 38, 3, 0, 1, 16, 4, 0, 119, 0, 17, 0, 2, 39, 0, 0, 59, 115, 15, 0, 135, 38, 32, 0, 2, 39, 0, 0, 120, 38, 3, 0, 1, 16, 15, 0, 119, 0, 10, 0, 2, 39, 0, 0, 176, 119, 15, 0, 135, 38, 32, 0, 2, 39, 0, 0, 32, 16, 38, 0, 1, 38, 9, 0, 1, 39, 11, 0, 125, 16, 16, 38, 39, 0, 0, 0, 2, 38, 0, 0, 59, 115, 15, 0, 135, 39, 32, 0, 2, 38, 0, 0, 32, 18, 39, 0, 2, 39, 0, 0, 168, 240, 14, 0, 85, 39, 2, 0, 25, 19, 1, 1, 78, 3, 19, 0, 78, 4, 1, 0, 41, 39, 4, 24, 42, 39, 39, 24, 41, 38, 3, 24, 42, 38, 38, 24, 3, 39, 39, 38, 1, 41, 254, 255, 1, 40, 5, 0, 138, 39, 41, 40, 28, 36, 0, 0, 32, 36, 0, 0, 36, 36, 0, 0, 44, 36, 0, 0, 76, 36, 0, 0, 1, 17, 0, 0, 119, 0, 15, 0, 119, 0, 12, 0, 119, 0, 3, 0, 1, 17, 47, 0, 119, 0, 11, 0, 41, 38, 3, 24, 42, 38, 38, 24, 32, 38, 38, 0, 1, 40, 45, 0, 1, 41, 124, 0, 125, 17, 38, 40, 41, 0, 0, 0, 119, 0, 3, 0, 1, 17, 92, 0, 119, 0, 1, 0, 79, 39, 0, 0, 103, 41, 0, 1, 41, 41, 41, 8, 20, 39, 39, 41, 0, 7, 39, 0, 84, 24, 7, 0, 25, 20, 24, 1, 19, 39, 17, 36, 0, 21, 39, 0, 2, 39, 0, 0, 59, 4, 16, 0, 13, 22, 0, 39, 25, 23, 0, 1, 1, 5, 0, 0, 1, 14, 0, 0, 2, 39, 0, 0, 59, 4, 16, 0, 14, 39, 0, 39, 38, 39, 39, 1, 0, 15, 39, 0, 2, 39, 0, 0, 255, 255, 0, 0, 19, 39, 7, 39, 43, 39, 39, 8, 2, 41, 0, 0, 255, 255, 0, 0, 19, 39, 39, 41, 0, 6, 39, 0, 2, 39, 0, 0, 255, 255, 0, 0, 19, 39, 7, 39, 0, 7, 39, 0, 19, 39, 6, 36, 19, 41, 3, 36, 3, 6, 39, 41, 19, 41, 6, 36, 0, 8, 41, 0, 83, 20, 8, 0, 19, 41, 7, 36, 19, 39, 4, 36, 3, 13, 41, 39, 19, 39, 13, 36, 0, 3, 39, 0, 83, 24, 3, 0, 41, 39, 6, 24, 42, 39, 39, 24, 0, 12, 39, 0, 41, 39, 13, 24, 42, 39, 39, 24, 0, 13, 39, 0, 135, 4, 33, 0, 12, 13, 0, 0, 27, 39, 5, 3, 3, 11, 32, 39, 0, 9, 11, 0, 80, 10, 24, 0, 83, 9, 10, 0, 42, 41, 10, 8, 107, 9, 1, 41, 135, 9, 12, 0, 12, 13, 0, 0, 25, 11, 11, 2, 19, 39, 9, 36, 45, 39, 39, 21, 100, 37, 0, 0, 1, 39, 0, 0, 0, 41, 39, 0, 119, 0, 3, 0, 19, 39, 9, 36, 0, 41, 39, 0, 83, 11, 41, 0, 19, 41, 4, 36, 0, 9, 41, 0, 2, 41, 0, 0, 255, 255, 0, 0, 19, 41, 10, 41, 0, 7, 41, 0, 19, 41, 4, 36, 41, 41, 41, 24, 42, 41, 41, 24, 1, 40, 186, 255, 1, 38, 103, 0, 138, 41, 40, 38, 44, 43, 0, 0, 48, 43, 0, 0, 52, 43, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 56, 43, 0, 0, 60, 43, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 64, 43, 0, 0, 68, 43, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 60, 39, 0, 0, 184, 43, 0, 0, 41, 39, 15, 24, 42, 39, 39, 24, 120, 39, 129, 0, 135, 8, 34, 0, 12, 13, 0, 0, 120, 8, 5, 0, 0, 3, 14, 0, 1, 8, 0, 0, 1, 4, 0, 0, 119, 0, 230, 0, 41, 39, 14, 24, 42, 39, 39, 24, 32, 39, 39, 0, 38, 39, 39, 1, 0, 3, 39, 0, 27, 39, 8, 120, 3, 39, 35, 39, 25, 4, 39, 11, 78, 39, 4, 0, 33, 39, 39, 64, 121, 39, 8, 0, 2, 39, 0, 0, 128, 61, 16, 0, 26, 40, 12, 1, 27, 38, 13, 22, 3, 40, 40, 38, 90, 39, 39, 40, 83, 4, 39, 0, 1, 40, 3, 0, 135, 39, 35, 0, 40, 8, 0, 0, 32, 39, 39, 0, 20, 39, 18, 39, 120, 39, 28, 0, 32, 39, 9, 88, 121, 39, 9, 0, 27, 39, 8, 120, 3, 39, 35, 39, 102, 39, 39, 10, 33, 39, 39, 88, 121, 39, 4, 0, 1, 8, 0, 0, 1, 4, 1, 0, 119, 0, 196, 0, 121, 22, 3, 0, 135, 39, 36, 0, 24, 0, 0, 0, 2, 39, 0, 0, 240, 232, 14, 0], eb + 0);
    HEAPU8.set([26, 40, 9, 65, 27, 40, 40, 68, 94, 8, 39, 40, 85, 28, 2, 0, 109, 28, 4, 8, 2, 40, 0, 0, 81, 120, 15, 0, 135, 39, 23, 0, 40, 28, 0, 0, 1, 8, 0, 0, 1, 4, 1, 0, 119, 0, 179, 0, 27, 39, 8, 120, 3, 39, 35, 39, 102, 39, 39, 14, 32, 39, 39, 68, 121, 39, 13, 0, 2, 40, 0, 0, 53, 115, 15, 0, 135, 39, 32, 0, 2, 40, 0, 0, 120, 39, 8, 0, 2, 40, 0, 0, 47, 120, 15, 0, 135, 39, 23, 0, 40, 26, 0, 0, 1, 8, 1, 0, 1, 4, 1, 0, 119, 0, 162, 0, 135, 4, 37, 0, 19, 39, 4, 36, 0, 8, 39, 0, 41, 39, 4, 24, 42, 39, 39, 24, 121, 39, 33, 0, 27, 39, 8, 120, 3, 15, 35, 39, 1, 40, 24, 0, 107, 15, 77, 40, 1, 39, 10, 0, 107, 15, 79, 39, 25, 14, 15, 82, 1, 39, 54, 100, 84, 14, 39, 0, 2, 40, 0, 0, 54, 100, 54, 0, 43, 40, 40, 16, 108, 14, 2, 40, 25, 14, 15, 90, 1, 40, 54, 100, 84, 14, 40, 0, 2, 39, 0, 0, 54, 100, 54, 0, 43, 39, 39, 16, 108, 14, 2, 39, 1, 40, 30, 0, 109, 15, 104, 40, 1, 39, 0, 0, 109, 15, 108, 39, 25, 15, 15, 3, 83, 15, 10, 0, 42, 40, 10, 8, 107, 15, 1, 40, 135, 40, 38, 0, 12, 13, 8, 0, 135, 40, 29, 0, 4, 0, 0, 0, 135, 40, 12, 0, 12, 13, 0, 0, 45, 40, 40, 21, 40, 41, 0, 0, 1, 8, 1, 0, 1, 4, 1, 0, 119, 0, 117, 0, 135, 40, 12, 0, 12, 13, 0, 0, 19, 40, 40, 36, 0, 8, 40, 0, 83, 11, 8, 0, 1, 8, 1, 0, 1, 4, 1, 0, 119, 0, 109, 0, 2, 39, 0, 0, 59, 4, 16, 0, 78, 39, 39, 0, 41, 38, 3, 24, 42, 38, 38, 24, 45, 39, 39, 38, 132, 41, 0, 0, 2, 39, 0, 0, 60, 4, 16, 0, 78, 39, 39, 0, 41, 38, 8, 24, 42, 38, 38, 24, 13, 39, 39, 38, 0, 40, 39, 0, 119, 0, 3, 0, 1, 39, 0, 0, 0, 40, 39, 0, 121, 40, 88, 0, 41, 40, 14, 24, 42, 40, 40, 24, 32, 40, 40, 0, 38, 40, 40, 1, 0, 3, 40, 0, 1, 39, 3, 0, 135, 40, 25, 0, 39, 0, 0, 0, 121, 40, 9, 0, 85, 27, 2, 0, 2, 39, 0, 0, 189, 120, 15, 0, 135, 40, 23, 0, 39, 27, 0, 0, 1, 8, 0, 0, 1, 4, 0, 0, 119, 0, 74, 0, 121, 18, 27, 0, 2, 39, 0, 0, 109, 120, 15, 0, 135, 40, 23, 0, 39, 29, 0, 0, 1, 40, 20, 0, 2, 39, 0, 0, 148, 200, 16, 0, 82, 39, 39, 0, 49, 40, 40, 39, 12, 42, 0, 0, 1, 8, 1, 0, 1, 4, 0, 0, 119, 0, 60, 0, 1, 40, 7, 0, 135, 8, 39, 0, 40, 0, 0, 0, 2, 40, 0, 0, 148, 200, 16, 0, 2, 39, 0, 0, 148, 200, 16, 0, 82, 39, 39, 0, 3, 39, 39, 8, 85, 40, 39, 0, 1, 8, 1, 0, 1, 4, 0, 0, 119, 0, 47, 0, 1, 39, 6, 0, 1, 40, 6, 0, 135, 15, 31, 0, 39, 40, 0, 0, 2, 40, 0, 0, 92, 4, 16, 0, 82, 40, 40, 0, 4, 15, 40, 15, 2, 40, 0, 0, 92, 4, 16, 0, 85, 40, 15, 0, 34, 40, 15, 1, 121, 40, 23, 0, 121, 22, 8, 0, 1, 39, 98, 0, 134, 40, 0, 0, 120, 137, 0, 0, 39, 0, 0, 0, 78, 40, 34, 0, 120, 40, 90, 0, 119, 0, 15, 0, 78, 39, 23, 0, 78, 38, 0, 0, 135, 40, 34, 0, 39, 38, 0, 0, 27, 40, 40, 120, 3, 40, 35, 40, 25, 15, 40, 14, 78, 38, 15, 0, 134, 40, 0, 0, 120, 137, 0, 0, 38, 0, 0, 0, 78, 40, 34, 0, 120, 40, 76, 0, 119, 0, 1, 0, 85, 30, 2, 0, 2, 38, 0, 0, 166, 120, 15, 0, 135, 40, 23, 0, 38, 30, 0, 0, 1, 8, 1, 0, 1, 4, 0, 0, 119, 0, 4, 0, 0, 3, 14, 0, 1, 8, 0, 0, 0, 4, 15, 0, 1, 38, 1, 0, 134, 40, 0, 0, 204, 220, 0, 0, 38, 0, 0, 0, 135, 40, 11, 0, 16, 0, 0, 0, 135, 40, 8, 0, 12, 13, 17, 0, 1, 38, 7, 0, 135, 40, 11, 0, 38, 0, 0, 0, 0, 9, 5, 0, 119, 0, 37, 0, 119, 0, 6, 0, 119, 0, 5, 0, 119, 0, 4, 0, 119, 0, 3, 0, 119, 0, 2, 0, 119, 0, 1, 0, 1, 39, 0, 0, 79, 40, 19, 0, 4, 39, 39, 40, 83, 19, 39, 0, 1, 39, 0, 0, 79, 40, 1, 0, 4, 39, 39, 40, 83, 1, 39, 0, 85, 25, 2, 0, 2, 40, 0, 0, 31, 120, 15, 0, 135, 39, 23, 0, 40, 25, 0, 0, 26, 9, 5, 1, 1, 3, 0, 0, 1, 8, 0, 0, 41, 40, 14, 24, 42, 40, 40, 24, 32, 40, 40, 0, 121, 40, 7, 0, 41, 40, 15, 24, 42, 40, 40, 24, 32, 40, 40, 0, 38, 40, 40, 1, 0, 39, 40, 0, 119, 0, 2, 0, 0, 39, 15, 0, 0, 4, 39, 0, 119, 0, 2, 0, 119, 0, 227, 255, 25, 5, 9, 1, 41, 41, 8, 24, 42, 41, 41, 24, 32, 41, 41, 0, 34, 40, 9, 5, 19, 41, 41, 40, 120, 41, 3, 0, 1, 31, 42, 0, 119, 0, 6, 0, 0, 14, 3, 0, 0, 15, 4, 0, 78, 3, 19, 0, 78, 4, 1, 0, 119, 0, 57, 254, 32, 41, 31, 42, 121, 41, 24, 0, 1, 41, 255, 255, 47, 41, 41, 9, 88, 44, 0, 0, 1, 3, 0, 0, 1, 40, 1, 0, 134, 41, 0, 0, 204, 220, 0, 0, 40, 0, 0, 0, 27, 41, 3, 3, 3, 41, 32, 41, 102, 4, 41, 2, 41, 41, 4, 24, 42, 41, 41, 24, 121, 41, 7, 0, 27, 41, 3, 3, 3, 31, 32, 41, 102, 40, 31, 1, 78, 38, 31, 0, 135, 41, 8, 0, 40, 38, 4, 0, 25, 3, 3, 1, 53, 41, 3, 5, 12, 44, 0, 0, 137, 33, 0, 0, 139, 0, 0, 0, 140, 0, 21, 0, 0, 0, 0, 0, 2, 15, 0, 0, 76, 200, 16, 0, 2, 16, 0, 0, 232, 114, 15, 0, 2, 17, 0, 0, 228, 114, 15, 0, 1, 13, 0, 0, 136, 18, 0, 0, 0, 14, 18, 0, 136, 18, 0, 0, 25, 18, 18, 80, 137, 18, 0, 0, 25, 10, 14, 72, 25, 9, 14, 64, 25, 8, 14, 56, 25, 7, 14, 48, 25, 6, 14, 40, 25, 12, 14, 32, 25, 11, 14, 24, 25, 5, 14, 8, 0, 4, 14, 0, 25, 2, 14, 76, 25, 3, 2, 1, 1, 0, 0, 0, 120, 0, 13, 0, 2, 18, 0, 0, 62, 4, 16, 0, 80, 18, 18, 0, 1, 19, 0, 32, 19, 18, 18, 19, 120, 18, 3, 0, 1, 0, 0, 0, 119, 0, 5, 0, 1, 19, 2, 0, 135, 18, 1, 0, 19, 0, 0, 0, 25, 0, 18, 2, 1, 18, 1, 0, 83, 15, 18, 0, 2, 18, 0, 0, 148, 200, 16, 0, 82, 18, 18, 0, 120, 18, 169, 1, 134, 1, 0, 0, 68, 11, 0, 0, 1, 19, 33, 0, 1, 18, 94, 0, 138, 1, 19, 18, 208, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 36, 47, 0, 0, 160, 46, 0, 0, 40, 47, 0, 0, 44, 47, 0, 0, 52, 47, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 64, 47, 0, 0, 160, 46, 0, 0, 76, 47, 0, 0, 88, 47, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 100, 47, 0, 0, 104, 47, 0, 0, 200, 47, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 212, 47, 0, 0, 160, 46, 0, 0, 240, 47, 0, 0, 244, 47, 0, 0, 248, 47, 0, 0, 252, 47, 0, 0, 92, 48, 0, 0, 160, 46, 0, 0, 96, 48, 0, 0, 108, 48, 0, 0, 120, 48, 0, 0, 132, 48, 0, 0, 144, 48, 0, 0, 156, 48, 0, 0, 160, 46, 0, 0, 160, 48, 0, 0, 160, 46, 0, 0, 172, 48, 0, 0, 176, 48, 0, 0, 160, 46, 0, 0, 196, 48, 0, 0, 160, 46, 0, 0, 24, 49, 0, 0, 160, 46, 0, 0, 36, 49, 0, 0, 160, 46, 0, 0, 124, 49, 0, 0, 128, 49, 0, 0, 140, 49, 0, 0, 152, 49, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 164, 49, 0, 0, 204, 49, 0, 0, 240, 49, 0, 0, 244, 49, 0, 0, 248, 49, 0, 0, 160, 46, 0, 0, 252, 49, 0, 0, 0, 50, 0, 0, 160, 46, 0, 0, 12, 50, 0, 0, 24, 50, 0, 0, 36, 50, 0, 0, 44, 50, 0, 0, 56, 50, 0, 0, 60, 50, 0, 0, 124, 50, 0, 0, 160, 46, 0, 0, 136, 50, 0, 0, 140, 50, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 160, 46, 0, 0, 152, 50, 0, 0, 1, 19, 0, 0, 83, 15, 19, 0, 135, 19, 40, 0, 1, 0, 0, 0, 2, 19, 0, 0, 96, 176, 16, 0, 85, 10, 19, 0, 2, 18, 0, 0, 32, 115, 15, 0, 135, 19, 23, 0, 18, 10, 0, 0, 119, 0, 8, 1, 1, 18, 0, 0, 83, 15, 18, 0, 2, 18, 0, 0, 177, 198, 16, 0, 78, 18, 18, 0, 40, 18, 18, 1, 0, 1, 18, 0, 2, 18, 0, 0, 177, 198, 16, 0, 83, 18, 1, 0, 41, 19, 1, 24, 42, 19, 19, 24, 32, 19, 19, 0, 125, 18, 19, 17, 16, 0, 0, 0, 85, 12, 18, 0, 2, 19, 0, 0, 249, 114, 15, 0, 135, 18, 23, 0, 19, 12, 0, 0, 119, 0, 243, 0, 119, 0, 194, 0, 119, 0, 217, 0, 135, 18, 41, 0, 119, 0, 239, 0, 134, 18, 0, 0, 12, 116, 0, 0, 119, 0, 236, 0, 134, 18, 0, 0, 196, 218, 0, 0, 119, 0, 233, 0, 134, 18, 0, 0, 140, 226, 0, 0, 119, 0, 230, 0, 134, 18, 0, 0, 100, 222, 0, 0, 119, 0, 227, 0, 119, 0, 28, 0, 1, 19, 0, 0, 83, 15, 19, 0, 2, 19, 0, 0, 85, 200, 16, 0, 78, 19, 19, 0, 120, 19, 12, 0, 1, 18, 67, 0, 135, 19, 40, 0, 18, 0, 0, 0, 2, 19, 0, 0, 96, 176, 16, 0, 85, 8, 19, 0, 2, 18, 0, 0, 32, 115, 15, 0, 135, 19, 23, 0, 18, 8, 0, 0, 119, 0, 209, 0, 2, 19, 0, 0, 86, 200, 16, 0, 1, 18, 1, 0, 83, 19, 18, 0, 134, 18, 0, 0, 148, 147, 0, 0, 119, 0, 202, 0, 134, 18, 0, 0, 20, 62, 0, 0, 119, 0, 199, 0, 135, 20, 42, 0, 1, 0, 0, 0, 1, 19, 255, 0, 19, 20, 20, 19, 135, 18, 43, 0, 20, 0, 0, 0, 119, 0, 192, 0, 119, 0, 249, 255, 119, 0, 248, 255, 119, 0, 247, 255, 1, 18, 0, 0, 83, 15, 18, 0, 2, 18, 0, 0, 85, 200, 16, 0, 78, 18, 18, 0, 120, 18, 12, 0, 1, 19, 77, 0, 135, 18, 40, 0, 19, 0, 0, 0, 2, 18, 0, 0, 96, 176, 16, 0, 85, 9, 18, 0, 2, 19, 0, 0, 32, 115, 15, 0, 135, 18, 23, 0, 19, 9, 0, 0, 119, 0, 172, 0, 2, 18, 0, 0, 86, 200, 16, 0, 1, 19, 1, 0, 83, 18, 19, 0, 134, 19, 0, 0, 52, 206, 0, 0, 119, 0, 165, 0, 119, 0, 222, 255, 134, 18, 0, 0, 124, 182, 0, 0, 119, 0, 161, 0, 134, 18, 0, 0, 28, 186, 0, 0, 119, 0, 158, 0, 134, 18, 0, 0, 228, 211, 0, 0, 119, 0, 155, 0, 134, 18, 0, 0, 60, 227, 0, 0, 119, 0, 152, 0, 134, 18, 0, 0, 136, 221, 0, 0, 119, 0, 149, 0, 119, 0, 206, 255, 134, 18, 0, 0, 156, 217, 0, 0, 119, 0, 145, 0, 119, 0, 202, 255, 1, 19, 0, 0, 83, 15, 19, 0, 134, 19, 0, 0, 108, 223, 0, 0, 119, 0, 139, 0, 1, 18, 0, 0, 83, 15, 18, 0, 2, 18, 0, 0, 178, 198, 16, 0, 78, 18, 18, 0, 40, 18, 18, 1, 0, 1, 18, 0, 2, 18, 0, 0, 178, 198, 16, 0, 83, 18, 1, 0, 41, 19, 1, 24, 42, 19, 19, 24, 32, 19, 19, 0, 125, 18, 19, 17, 16, 0, 0, 0, 85, 11, 18, 0, 2, 19, 0, 0, 235, 114, 15, 0, 135, 18, 23, 0, 19, 11, 0, 0, 119, 0, 118, 0, 134, 18, 0, 0, 216, 219, 0, 0, 119, 0, 115, 0, 1, 18, 0, 0, 83, 15, 18, 0, 2, 18, 0, 0, 176, 198, 16, 0, 2, 19, 0, 0, 176, 198, 16, 0, 78, 19, 19, 0, 40, 19, 19, 1, 83, 18, 19, 0, 135, 19, 44, 0, 2, 18, 0, 0, 176, 198, 16, 0, 78, 18, 18, 0, 32, 18, 18, 0, 125, 19, 18, 17, 16, 0, 0, 0, 85, 6, 19, 0, 2, 18, 0, 0, 12, 115, 15, 0, 135, 19, 23, 0, 18, 6, 0, 0, 119, 0, 93, 0, 119, 0, 10, 0, 134, 18, 0, 0, 132, 170, 0, 0, 119, 0, 89, 0, 134, 18, 0, 0, 60, 131, 0, 0, 119, 0, 86, 0, 134, 18, 0, 0, 192, 160, 0, 0, 119, 0, 83, 0, 1, 19, 255, 0, 19, 19, 1, 19, 135, 18, 45, 0, 19, 2, 0, 0, 78, 19, 3, 0, 78, 20, 2, 0, 134, 18, 0, 0, 4, 83, 0, 0, 19, 20, 0, 0, 119, 0, 73, 0, 1, 18, 0, 0, 83, 15, 18, 0, 1, 20, 0, 0, 2, 19, 0, 0, 162, 236, 16, 0, 134, 18, 0, 0, 156, 126, 0, 0, 20, 19, 0, 0, 119, 0, 64, 0, 119, 0, 237, 255, 119, 0, 236, 255, 119, 0, 235, 255, 119, 0, 234, 255, 134, 18, 0, 0, 44, 224, 0, 0, 119, 0, 57, 0, 134, 18, 0, 0, 72, 124, 0, 0, 119, 0, 54, 0, 134, 18, 0, 0, 148, 113, 0, 0, 119, 0, 51, 0, 135, 18, 46, 0, 119, 0, 49, 0, 134, 18, 0, 0, 204, 140, 0, 0, 119, 0, 46, 0, 119, 0, 219, 255, 1, 18, 0, 0, 83, 15, 18, 0, 2, 18, 0, 0, 159, 114, 15, 0, 85, 5, 18, 0, 2, 19, 0, 0, 207, 114, 15, 0, 109, 5, 4, 19, 2, 18, 0, 0, 219, 114, 15, 0, 109, 5, 8, 18, 2, 19, 0, 0, 145, 114, 15, 0, 135, 18, 23, 0, 19, 5, 0, 0, 119, 0, 29, 0, 134, 18, 0, 0, 16, 215, 0, 0, 119, 0, 26, 0, 119, 0, 199, 255, 134, 18, 0, 0, 56, 95, 0, 0, 119, 0, 22, 0, 1, 19, 0, 0, 83, 15, 19, 0, 2, 19, 0, 0, 175, 198, 16, 0, 78, 19, 19, 0, 40, 19, 19, 1, 0, 1, 19, 0, 2, 19, 0, 0, 175, 198, 16, 0, 83, 19, 1, 0, 41, 18, 1, 24, 42, 18, 18, 24, 32, 18, 18, 0, 125, 19, 18, 16, 17, 0, 0, 0, 85, 7, 19, 0, 2, 18, 0, 0, 22, 115, 15, 0, 135, 19, 23, 0, 18, 7, 0, 0, 119, 0, 1, 0, 2, 19, 0, 0, 74, 200, 16, 0, 78, 19, 19, 0, 1, 20, 1, 0, 1, 18, 2, 0, 138, 19, 20, 18, 16, 51, 0, 0, 20, 51, 0, 0, 119, 0, 7, 0, 119, 0, 122, 0, 2, 18, 0, 0, 74, 200, 16, 0, 1, 20, 0, 0, 83, 18, 20, 0, 119, 0, 65, 0, 2, 19, 0, 0, 80, 200, 16, 0, 78, 1, 19, 0, 41, 19, 1, 24, 42, 19, 19, 24, 33, 19, 19, 0, 2, 20, 0, 0, 79, 200, 16, 0, 78, 20, 20, 0, 33, 20, 20, 0, 19, 19, 19, 20, 121, 19, 3, 0, 135, 19, 47, 0, 1, 0, 0, 0, 2, 19, 0, 0, 80, 200, 16, 0, 1, 20, 0, 0, 83, 19, 20, 0, 2, 20, 0, 0, 94, 200, 16, 0, 78, 20, 20, 0, 120, 20, 5, 0, 2, 20, 0, 0, 91, 200, 16, 0, 1, 19, 0, 0, 83, 20, 19, 0, 78, 19, 15, 0, 120, 19, 6, 0, 2, 19, 0, 0, 112, 200, 16, 0, 1, 20, 0, 0, 85, 19, 20, 0, 119, 0, 32, 0, 1, 13, 57, 0, 119, 0, 30, 0, 1, 19, 10, 0, 134, 20, 0, 0, 204, 220, 0, 0, 19, 0, 0, 0, 1, 19, 25, 0, 135, 20, 2, 0, 19, 0, 0, 0, 2, 20, 0, 0, 148, 200, 16, 0, 82, 1, 20, 0, 2, 20, 0, 0, 148, 200, 16, 0, 26, 19, 1, 1, 85, 20, 19, 0, 34, 19, 1, 2, 121, 19, 11, 0, 2, 19, 0, 0, 148, 200, 16, 0, 1, 20, 0, 0, 85, 19, 20, 0, 1, 20, 0, 0, 83, 15, 20, 0, 2, 19, 0, 0, 125, 114, 15, 0, 135, 20, 23, 0, 19, 4, 0, 0, 78, 20, 15, 0, 121, 20, 2, 0, 1, 13, 57, 0, 32, 20, 13, 57, 121, 20, 39, 254, 1, 13, 0, 0, 1, 20, 0, 0, 83, 15, 20, 0, 32, 19, 0, 0, 121, 19, 4, 0, 1, 19, 0, 0, 0, 20, 19, 0, 119, 0, 3, 0, 26, 19, 0, 1, 0, 20, 19, 0, 0, 0, 20, 0, 120, 0, 27, 254, 134, 20, 0, 0, 0, 174, 0, 0, 2, 20, 0, 0, 74, 200, 16, 0, 78, 20, 20, 0, 1, 18, 1, 0, 1, 19, 2, 0, 138, 20, 18, 19, 140, 52, 0, 0, 144, 52, 0, 0, 119, 0, 8, 0, 119, 0, 27, 0, 2, 19, 0, 0, 74, 200, 16, 0, 1, 18, 0, 0, 83, 19, 18, 0, 1, 0, 0, 0, 119, 0, 9, 254, 134, 20, 0, 0, 124, 193, 0, 0, 2, 20, 0, 0, 74, 200, 16, 0, 78, 20, 20, 0, 1, 19, 1, 0, 1, 18, 2, 0, 138, 20, 19, 18, 220, 52, 0, 0, 224, 52, 0, 0, 135, 19, 48, 0, 1, 0, 0, 0, 119, 0, 252, 253, 119, 0, 7, 0, 2, 18, 0, 0, 74, 200, 16, 0, 1, 19, 0, 0, 83, 18, 19, 0, 1, 0, 0, 0, 119, 0, 245, 253, 137, 14, 0, 0, 139, 0, 0, 0, 140, 0, 18, 0, 0, 0, 0, 0, 2, 11, 0, 0, 192, 3, 16, 0, 2, 12, 0, 0, 255, 0, 0, 0, 2, 13, 0, 0, 35, 50, 4, 0, 1, 3, 0, 0, 136, 14, 0, 0, 0, 9, 14, 0, 136, 14, 0, 0, 25, 14, 14, 32, 137, 14, 0, 0, 25, 8, 9, 24, 25, 7, 9, 16, 0, 5, 9, 0, 2, 14, 0, 0, 140, 200, 16, 0, 82, 6, 14, 0, 2, 14, 0, 0, 168, 198, 16, 0, 1, 15, 2, 0, 85, 14, 15, 0, 1, 14, 0, 0, 135, 15, 49, 0, 14, 0, 0, 0, 1, 14, 9, 0, 135, 15, 11, 0, 14, 0, 0, 0, 1, 14, 7, 0, 1, 16, 1, 0, 2, 17, 0, 0, 191, 126, 15, 0, 135, 15, 50, 0, 14, 16, 17, 0, 1, 17, 8, 0, 1, 16, 1, 0, 2, 14, 0, 0, 13, 127, 15, 0, 135, 15, 50, 0, 17, 16, 14, 0, 1, 14, 9, 0, 1, 16, 1, 0, 2, 17, 0, 0, 91, 127, 15, 0, 135, 15, 50, 0, 14, 16, 17, 0, 1, 17, 10, 0, 1, 16, 1, 0, 2, 14, 0, 0, 169, 127, 15, 0, 135, 15, 50, 0, 17, 16, 14, 0, 1, 14, 11, 0, 1, 16, 1, 0, 2, 17, 0, 0, 245, 127, 15, 0, 135, 15, 50, 0, 14, 16, 17, 0, 1, 17, 10, 0, 135, 15, 11, 0, 17, 0, 0, 0, 1, 17, 13, 0, 1, 16, 21, 0, 2, 14, 0, 0, 67, 128, 15, 0, 135, 15, 50, 0, 17, 16, 14, 0, 1, 14, 7, 0, 135, 15, 11, 0, 14, 0, 0, 0, 1, 14, 15, 0, 1, 16, 23, 0, 2, 17, 0, 0, 105, 128, 15, 0, 135, 15, 50, 0, 14, 16, 17, 0, 1, 17, 16, 0, 1, 16, 25, 0, 2, 14, 0, 0, 140, 128, 15, 0, 135, 15, 50, 0, 17, 16, 14, 0, 1, 14, 17, 0, 1, 16, 25, 0, 2, 17, 0, 0, 171, 128, 15, 0, 135, 15, 50, 0, 14, 16, 17, 0, 1, 17, 23, 0, 1, 16, 0, 0, 2, 14, 0, 0, 96, 113, 15, 0, 135, 15, 50, 0, 17, 16, 14, 0, 135, 15, 51, 0, 1, 14, 0, 0, 1, 16, 1, 0, 134, 15, 0, 0, 84, 163, 0, 0, 14, 16, 0, 0, 134, 15, 0, 0, 4, 229, 0, 0, 33, 15, 15, 32, 121, 15, 8, 0, 1, 16, 2, 0, 135, 15, 2, 0, 16, 0, 0, 0, 134, 15, 0, 0, 4, 229, 0, 0, 33, 15, 15, 32, 120, 15, 250, 255, 1, 16, 0, 0, 135, 15, 49, 0, 16, 0, 0, 0, 2, 15, 0, 0, 64, 4, 16, 0, 78, 2, 15, 0, 41, 15, 2, 24, 42, 15, 15, 24, 120, 15, 3, 0, 1, 0, 0, 0, 119, 0, 172, 1, 1, 0, 0, 0, 1, 1, 0, 0, 19, 15, 2, 12, 0, 4, 15, 0, 27, 15, 4, 120, 3, 15, 11, 15, 102, 15, 15, 77, 1, 14, 173, 255, 1, 16, 108, 0, 138, 15, 14, 16, 204, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 48, 57, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 164, 57, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 192, 57, 0, 0, 152, 58, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 180, 59, 0, 0, 188, 59, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 200, 56, 0, 0, 32, 60, 0, 0, 119, 0, 10, 1, 27, 16, 4, 120, 3, 1, 11, 16, 103, 3, 1, 79, 106, 16, 1, 100, 2, 14, 0, 0, 208, 241, 14, 0, 27, 17, 3, 12, 3, 14, 14, 17, 106, 14, 14, 8, 5, 1, 16, 14, 2, 14, 0, 0, 5, 204, 16, 0, 3, 3, 14, 3, 78, 16, 3, 0, 32, 16, 16, 0, 121, 16, 4, 0, 28, 16, 1, 2, 0, 14, 16, 0, 119, 0, 2, 0, 0, 14, 1, 0, 0, 1, 14, 0, 1, 14, 1, 0, 83, 3, 14, 0, 1, 3, 37, 0, 119, 0, 241, 0, 27, 14, 4, 120, 3, 2, 11, 14, 103, 10, 2, 79, 106, 14, 2, 116, 27, 14, 14, 20, 2, 16, 0, 0, 48, 243, 14, 0, 27, 17, 10, 12, 3, 16, 16, 17, 106, 16, 16, 8, 3, 1, 14, 16, 25, 2, 2, 76, 78, 3, 2, 0, 39, 16, 3, 2, 83, 2, 16, 0, 2, 16, 0, 0, 19, 204, 16, 0, 1, 14, 1, 0, 95, 16, 10, 14, 38, 16, 3, 2, 32, 16, 16, 0, 121, 16, 4, 0, 28, 16, 1, 2, 0, 14, 16, 0, 119, 0, 2, 0, 0, 14, 1, 0, 0, 1, 14, 0, 1, 3, 37, 0, 119, 0, 212, 0, 27, 16, 4, 120, 3, 16, 11, 16, 106, 16, 16, 100, 41, 16, 16, 1, 0, 1, 16, 0, 1, 3, 37, 0, 119, 0, 205, 0, 27, 16, 4, 120, 3, 16, 11, 16, 102, 2, 16, 79, 41, 16, 2, 24, 42, 16, 16, 24, 1, 14, 0, 0, 1, 17, 8, 0, 138, 16, 14, 17, 4, 58, 0, 0, 12, 58, 0, 0, 20, 58, 0, 0, 28, 58, 0, 0, 36, 58, 0, 0, 44, 58, 0, 0, 52, 58, 0, 0, 60, 58, 0, 0, 119, 0, 17, 0, 1, 1, 20, 0, 119, 0, 15, 0, 1, 1, 25, 0, 119, 0, 13, 0, 1, 1, 20, 0, 119, 0, 11, 0, 1, 1, 30, 0, 119, 0, 9, 0, 1, 1, 75, 0, 119, 0, 7, 0, 1, 1, 80, 0, 119, 0, 5, 0, 1, 1, 90, 0, 119, 0, 3, 0, 1, 1, 150, 0, 119, 0, 1, 0, 27, 16, 4, 120, 3, 3, 11, 16, 106, 10, 3, 116, 1, 16, 9, 0, 4, 16, 16, 10, 27, 16, 16, 100, 3, 16, 16, 1, 2, 14, 0, 0, 240, 240, 14, 0, 19, 17, 2, 12, 41, 17, 17, 2, 94, 14, 14, 17, 4, 14, 14, 10, 27, 14, 14, 10, 3, 1, 16, 14, 25, 3, 3, 76, 78, 14, 3, 0, 39, 14, 14, 2, 83, 3, 14, 0, 1, 3, 37, 0, 119, 0, 151, 0, 27, 14, 4, 120, 3, 14, 11, 14, 102, 10, 14, 79, 19, 14, 10, 12, 0, 2, 14, 0, 2, 14, 0, 0, 32, 231, 14, 0, 2, 16, 0, 0, 12, 210, 16, 0, 41, 17, 2, 2, 94, 16, 16, 17, 41, 16, 16, 2, 94, 14, 14, 16, 2, 16, 0, 0, 128, 242, 14, 0, 27, 17, 2, 12, 3, 16, 16, 17, 106, 16, 16, 8, 3, 1, 14, 16, 41, 16, 10, 24, 42, 16, 16, 24, 1, 14, 0, 0, 1, 17, 9, 0, 138, 16, 14, 17, 32, 59, 0, 0, 36, 59, 0, 0, 28, 59, 0, 0, 28, 59, 0, 0, 28, 59, 0, 0, 28, 59, 0, 0, 28, 59, 0, 0, 92, 59, 0, 0, 96, 59, 0, 0, 119, 0, 18, 0, 119, 0, 1, 0, 27, 14, 4, 120, 3, 14, 11, 14, 106, 10, 14, 116, 1, 17, 0, 0, 47, 17, 17, 10, 76, 59, 0, 0, 27, 17, 10, 100, 3, 17, 17, 1, 0, 14, 17, 0, 119, 0, 3, 0, 1, 17, 10, 0, 0, 14, 17, 0, 0, 1, 14, 0, 119, 0, 3, 0, 119, 0, 242, 255, 119, 0, 241, 255, 27, 16, 4, 120, 3, 16, 11, 16, 25, 10, 16, 76, 78, 3, 10, 0, 39, 16, 3, 2, 83, 10, 16, 0, 2, 16, 0, 0, 232, 203, 16, 0, 1, 14, 1, 0, 95, 16, 2, 14, 38, 16, 3, 2, 32, 16, 16, 0, 121, 16, 4, 0, 28, 16, 1, 2, 0, 14, 16, 0, 119, 0, 2, 0, 0, 14, 1, 0, 0, 1, 14, 0, 1, 3, 37, 0, 119, 0, 80, 0, 1, 1, 232, 3, 119, 0, 78, 0, 27, 14, 4, 120, 3, 1, 11, 14, 103, 3, 1, 79, 106, 14, 1, 100, 2, 16, 0, 0, 16, 241, 14, 0, 27, 17, 3, 12, 3, 16, 16, 17, 106, 16, 16, 8, 5, 1, 14, 16, 2, 16, 0, 0, 246, 203, 16, 0, 3, 3, 16, 3, 78, 14, 3, 0, 32, 14, 14, 0, 121, 14, 4, 0, 28, 14, 1, 2, 0, 16, 14, 0, 119, 0, 2, 0, 0, 16, 1, 0, 0, 1, 16, 0, 1, 16, 1, 0, 83, 3, 16, 0, 1, 3, 37, 0, 119, 0, 53, 0, 27, 16, 4, 120, 3, 16, 11, 16, 102, 16, 16, 79, 1, 14, 0, 0, 1, 17, 10, 0, 138, 16, 14, 17, 100, 60, 0, 0, 108, 60, 0, 0, 116, 60, 0, 0, 124, 60, 0, 0, 132, 60, 0, 0, 140, 60, 0, 0, 148, 60, 0, 0, 156, 60, 0, 0, 164, 60, 0, 0, 172, 60, 0, 0, 119, 0, 21, 0, 1, 1, 8, 0, 119, 0, 19, 0, 1, 1, 15, 0, 119, 0, 17, 0, 1, 1, 15, 0, 119, 0, 15, 0, 1, 1, 1, 0, 119, 0, 13, 0, 1, 1, 2, 0, 119, 0, 11, 0, 1, 1, 75, 0, 119, 0, 9, 0, 1, 1, 1, 0, 119, 0, 7, 0, 1, 1, 30, 0, 119, 0, 5, 0, 1, 1, 1, 0, 119, 0, 3, 0, 1, 1, 5, 0, 119, 0, 1, 0, 27, 16, 4, 120, 3, 3, 11, 16, 106, 16, 3, 108, 106, 14, 3, 104, 3, 16, 16, 14, 27, 16, 16, 3, 106, 14, 3, 100, 3, 16, 16, 14, 5, 1, 16, 1, 25, 3, 3, 76, 78, 16, 3, 0, 39, 16, 16, 2, 83, 3, 16, 0, 1, 3, 37, 0, 119, 0, 1, 0, 32, 15, 3, 37, 121, 15, 7, 0, 1, 3, 0, 0, 1, 15, 0, 0, 15, 15, 15, 1, 1, 14, 0, 0, 125, 1, 15, 1, 14, 0, 0, 0, 1, 15, 0, 0, 135, 14, 52, 0, 0, 15, 0, 0, 135, 2, 53, 0, 4, 0, 0, 0, 1, 15, 0, 0, 135, 14, 28, 0, 4, 15, 0, 0, 85, 5, 2, 0, 109, 5, 4, 1, 2, 15, 0, 0, 242, 200, 16, 0, 109, 5, 8, 15, 2, 14, 0, 0, 203, 128, 15, 0, 135, 15, 54, 0, 14, 5, 0, 0, 2, 15, 0, 0, 140, 200, 16, 0, 2, 14, 0, 0, 140, 200, 16, 0, 82, 14, 14, 0, 3, 14, 14, 1, 85, 15, 14, 0, 27, 14, 4, 120, 3, 14, 11, 14, 102, 2, 14, 1, 25, 0, 0, 1, 41, 14, 2, 24, 42, 14, 14, 24, 120, 14, 2, 0, 119, 0, 4, 0, 19, 14, 2, 12, 0, 4, 14, 0, 119, 0, 90, 254, 1, 15, 0, 0, 135, 14, 52, 0, 0, 15, 0, 0, 85, 7, 6, 0, 2, 15, 0, 0, 215, 128, 15, 0, 135, 14, 54, 0, 15, 7, 0, 0, 25, 15, 0, 1, 1, 16, 0, 0, 135, 14, 52, 0, 15, 16, 0, 0, 2, 14, 0, 0, 140, 200, 16, 0, 82, 14, 14, 0, 85, 8, 14, 0, 2, 16, 0, 0, 235, 128, 15, 0, 135, 14, 54, 0, 16, 8, 0, 0, 1, 16, 2, 0, 134, 14, 0, 0, 164, 109, 0, 0, 16, 0, 0, 0, 2, 14, 0, 0, 74, 200, 16, 0, 1, 16, 1, 0, 83, 14, 16, 0, 137, 9, 0, 0, 139, 0, 0, 0, 140, 0, 33, 0, 0, 0, 0, 0, 2, 25, 0, 0, 255, 0, 0, 0, 2, 26, 0, 0, 242, 200, 16, 0, 2, 27, 0, 0, 255, 255, 255, 127, 1, 12, 0, 0, 136, 28, 0, 0, 0, 24, 28, 0, 136, 28, 0, 0, 25, 28, 28, 64, 137, 28, 0, 0, 0, 23, 24, 0, 25, 17, 24, 48, 25, 18, 24, 32, 25, 19, 24, 18, 25, 20, 24, 4, 2, 28, 0, 0, 76, 200, 16, 0, 1, 29, 0, 0, 83, 28, 29, 0, 135, 21, 37, 0, 19, 29, 21, 25, 0, 22, 29, 0, 41, 29, 21, 24, 42, 29, 29, 24, 121, 29, 189, 1, 2, 29, 0, 0, 192, 3, 16, 0, 27, 28, 22, 120, 3, 29, 29, 28, 1, 28, 1, 0, 109, 29, 100, 28, 1, 0, 0, 0, 1, 1, 0, 0, 1, 3, 0, 0, 19, 28, 3, 27, 1, 29, 0, 0, 1, 30, 4, 0, 138, 28, 29, 30, 228, 62, 0, 0, 244, 62, 0, 0, 4, 63, 0, 0, 20, 63, 0, 0, 1, 29, 0, 0, 47, 29, 29, 0, 224, 62, 0, 0, 0, 2, 0, 0, 1, 12, 8, 0, 119, 0, 17, 0, 1, 2, 14, 0, 0, 1, 17, 0, 1, 12, 8, 0, 119, 0, 13, 0, 1, 2, 15, 0, 0, 1, 18, 0, 1, 12, 8, 0, 119, 0, 9, 0, 1, 2, 14, 0, 0, 1, 19, 0, 1, 12, 8, 0, 119, 0, 5, 0, 1, 2, 14, 0, 0, 1, 20, 0, 1, 12, 8, 0, 119, 0, 1, 0, 32, 28, 12, 8, 121, 28, 22, 0, 1, 12, 0, 0, 1, 0, 0, 0, 95, 1, 0, 0, 25, 0, 0, 1, 53, 28, 0, 2, 52, 63, 0, 0, 0, 0, 2, 0, 135, 15, 1, 0, 0, 0, 0, 0, 0, 16, 0, 0, 26, 0, 0, 1, 3, 13, 1, 0, 78, 14, 13, 0, 3, 15, 1, 15, 78, 28, 15, 0, 83, 13, 28, 0, 83, 15, 14, 0, 1, 28, 1, 0, 54, 28, 28, 16, 72, 63, 0, 0, 0, 0, 2, 0, 25, 3, 3, 1, 33, 28, 3, 4, 120, 28, 201, 255, 135, 28, 55, 0, 2, 28, 0, 0, 192, 3, 16, 0, 27, 29, 22, 120, 3, 16, 28, 29, 25, 15, 16, 77, 25, 16, 16, 79, 1, 0, 0, 0, 1, 1, 0, 0, 1, 2, 0, 0, 1, 4, 0, 0, 1, 5, 0, 0, 1, 3, 0, 0, 1, 13, 0, 0, 26, 14, 13, 11, 1, 29, 0, 0, 15, 29, 29, 14, 1, 28, 0, 0, 125, 14, 29, 14, 28, 0, 0, 0, 1, 29, 0, 0, 135, 28, 49, 0, 29, 0, 0, 0, 1, 9, 0, 0, 1, 11, 0, 0, 19, 28, 11, 27, 1, 29, 0, 0, 1, 30, 4, 0, 138, 28, 29, 30, 52, 64, 0, 0, 88, 64, 0, 0, 124, 64, 0, 0, 160, 64, 0, 0, 83, 15, 3, 0, 1, 29, 0, 0, 47, 29, 29, 5, 40, 64, 0, 0, 1, 12, 22, 0, 119, 0, 40, 0, 0, 6, 3, 0, 1, 12, 30, 0, 119, 0, 37, 0, 2, 1, 0, 0, 130, 206, 16, 0, 2, 2, 0, 0, 5, 204, 16, 0, 0, 4, 17, 0, 1, 5, 14, 0, 1, 3, 173, 0, 1, 12, 20, 0, 119, 0, 28, 0, 2, 1, 0, 0, 71, 205, 16, 0, 2, 2, 0, 0, 246, 203, 16, 0, 0, 4, 18, 0, 1, 5, 15, 0, 1, 3, 13, 0, 1, 12, 20, 0, 119, 0, 19, 0, 2, 1, 0, 0, 33, 204, 16, 0, 2, 2, 0, 0, 232, 203, 16, 0, 0, 4, 19, 0, 1, 5, 14, 0, 1, 3, 9, 0, 1, 12, 20, 0, 119, 0, 10, 0, 2, 1, 0, 0, 168, 207, 16, 0, 2, 2, 0, 0, 19, 204, 16, 0, 0, 4, 20, 0, 1, 5, 14, 0, 1, 3, 231, 0, 1, 12, 20, 0, 119, 0, 1, 0, 32, 28, 12, 20, 121, 28, 3, 0, 83, 15, 3, 0, 1, 12, 22, 0, 32, 28, 12, 22, 121, 28, 46, 0, 1, 12, 0, 0, 1, 6, 1, 0, 1, 10, 0, 0, 90, 8, 4, 10, 19, 28, 8, 25, 0, 7, 28, 0, 90, 28, 2, 7, 120, 28, 6, 0, 27, 28, 7, 21, 90, 28, 1, 28, 121, 28, 4, 0, 1, 12, 25, 0, 119, 0, 2, 0, 1, 12, 25, 0, 32, 28, 12, 25, 121, 28, 21, 0, 1, 12, 0, 0, 4, 6, 9, 14, 35, 28, 6, 22, 121, 28, 15, 0, 83, 16, 8, 0, 13, 30, 9, 13, 1, 31, 112, 0, 1, 32, 7, 0, 125, 29, 30, 31, 32, 0, 0, 0, 135, 28, 11, 0, 29, 0, 0, 0, 1, 29, 0, 0, 135, 28, 28, 0, 22, 29, 0, 0, 1, 29, 0, 0, 135, 28, 50, 0, 6, 29, 26, 0, 1, 6, 0, 0, 25, 9, 9, 1, 25, 10, 10, 1, 53, 28, 10, 5, 232, 64, 0, 0, 120, 6, 4, 0, 0, 8, 2, 0, 0, 6, 9, 0, 119, 0, 3, 0, 0, 6, 3, 0, 1, 12, 30, 0, 32, 28, 12, 30, 121, 28, 43, 0, 4, 3, 9, 14, 35, 28, 3, 22, 121, 28, 37, 0, 19, 28, 11, 27, 1, 29, 0, 0, 1, 32, 4, 0, 138, 28, 29, 32, 200, 65, 0, 0, 212, 65, 0, 0, 224, 65, 0, 0, 236, 65, 0, 0, 119, 0, 13, 0, 2, 0, 0, 0, 163, 124, 15, 0, 119, 0, 10, 0, 2, 0, 0, 0, 155, 124, 15, 0, 119, 0, 7, 0, 2, 0, 0, 0, 149, 124, 15, 0, 119, 0, 4, 0, 2, 0, 0, 0, 142, 124, 15, 0, 119, 0, 1, 0, 13, 32, 9, 13, 1, 31, 112, 0, 1, 30, 7, 0, 125, 29, 32, 31, 30, 0, 0, 0, 135, 28, 11, 0, 29, 0, 0, 0, 1, 29, 3, 0, 135, 28, 52, 0, 3, 29, 0, 0, 85, 23, 0, 0, 2, 29, 0, 0, 171, 124, 15, 0, 135, 28, 54, 0, 29, 23, 0, 0, 0, 8, 2, 0, 0, 3, 6, 0, 25, 6, 9, 1, 35, 28, 11, 3, 121, 28, 17, 0, 4, 2, 6, 14, 35, 28, 2, 22, 121, 28, 13, 0, 13, 30, 6, 13, 1, 31, 112, 0, 1, 32, 7, 0, 125, 29, 30, 31, 32, 0, 0, 0, 135, 28, 11, 0, 29, 0, 0, 0, 1, 29, 0, 0, 2, 32, 0, 0, 212, 124, 15, 0, 135, 28, 50, 0, 2, 29, 32, 0, 25, 6, 6, 1, 25, 11, 11, 1, 32, 28, 11, 4, 120, 28, 4, 0, 0, 9, 6, 0, 0, 2, 8, 0, 119, 0, 85, 255, 1, 32, 7, 0, 135, 28, 11, 0, 32, 0, 0, 0, 1, 32, 23, 0, 1, 29, 0, 0, 2, 31, 0, 0, 96, 113, 15, 0, 135, 28, 50, 0, 32, 29, 31, 0, 134, 28, 0, 0, 4, 229, 0, 0, 1, 31, 13, 0, 1, 29, 140, 0, 138, 28, 31, 29, 12, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 16, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 20, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 24, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 8, 69, 0, 0, 32, 69, 0, 0, 119, 0, 8, 0, 119, 0, 24, 0, 119, 0, 23, 0, 119, 0, 22, 0, 1, 12, 44, 0, 119, 0, 8, 0, 1, 12, 45, 0, 119, 0, 6, 0, 1, 31, 2, 0, 135, 28, 2, 0, 31, 0, 0, 0, 0, 2, 8, 0, 119, 0, 169, 254, 32, 28, 12, 44, 121, 28, 4, 0, 3, 28, 6, 13, 26, 7, 28, 1, 119, 0, 5, 0, 32, 28, 12, 45, 121, 28, 3, 0, 3, 28, 6, 13, 25, 7, 28, 1, 0, 2, 8, 0, 8, 13, 7, 6, 119, 0, 151, 254, 135, 28, 29, 0, 21, 0, 0, 0, 135, 28, 56, 0, 137, 24, 0, 0, 139, 0, 0, 0, 140, 0, 26, 0, 0, 0, 0, 0, 2, 18, 0, 0, 255, 255, 255, 127, 2, 19, 0, 0, 144, 244, 14, 0, 2, 20, 0, 0, 0, 2, 0, 0, 1, 16, 0, 0, 136, 21, 0, 0, 0, 17, 21, 0, 136, 21, 0, 0, 25, 21, 21, 16, 137, 21, 0, 0, 25, 14, 17, 4, 0, 15, 17, 0, 2, 21, 0, 0, 172, 198, 16, 0, 78, 21, 21, 0, 32, 13, 21, 0, 2, 21, 0, 0, 220, 245, 14, 0, 1, 23, 112, 0, 1, 24, 144, 0, 125, 22, 13, 23, 24, 0, 0, 0, 85, 21, 22, 0, 2, 22, 0, 0, 240, 245, 14, 0, 1, 24, 115, 0, 1, 23, 114, 0, 125, 21, 13, 24, 23, 0, 0, 0, 85, 22, 21, 0, 1, 22, 0, 0, 135, 21, 49, 0, 22, 0, 0, 0, 1, 13, 9, 0, 1, 22, 10, 0, 135, 21, 11, 0, 22, 0, 0, 0, 1, 22, 15, 0, 2, 23, 0, 0, 43, 141, 15, 0, 135, 21, 57, 0, 22, 23, 0, 0, 1, 23, 16, 0, 2, 22, 0, 0, 74, 141, 15, 0, 135, 21, 57, 0, 23, 22, 0, 0, 1, 22, 17, 0, 2, 23, 0, 0, 139, 141, 15, 0, 135, 21, 57, 0, 22, 23, 0, 0, 1, 23, 7, 0, 135, 21, 11, 0, 23, 0, 0, 0, 1, 23, 18, 0, 2, 22, 0, 0, 159, 114, 15, 0, 135, 21, 57, 0, 23, 22, 0, 0, 2, 21, 0, 0, 172, 198, 16, 0, 78, 21, 21, 0, 121, 21, 37, 0, 1, 22, 9, 0, 135, 21, 11, 0, 22, 0, 0, 0, 1, 22, 1, 0, 1, 23, 1, 0, 2, 24, 0, 0, 194, 200, 16, 0, 135, 21, 50, 0, 22, 23, 24, 0, 1, 24, 4, 0, 135, 21, 11, 0, 24, 0, 0, 0, 2, 21, 0, 0, 180, 198, 16, 0, 78, 21, 21, 0, 2, 24, 0, 0, 179, 198, 16, 0, 78, 24, 24, 0, 20, 21, 21, 24, 2, 24, 0, 0, 86, 200, 16, 0, 78, 24, 24, 0, 20, 21, 21, 24, 2, 24, 0, 0, 87, 200, 16, 0, 78, 24, 24, 0, 20, 21, 21, 24, 41, 21, 21, 24, 42, 21, 21, 24, 121, 21, 7, 0, 1, 24, 2, 0, 1, 23, 1, 0, 2, 22, 0, 0, 218, 141, 15, 0, 135, 21, 50, 0, 24, 23, 22, 0, 1, 3, 0, 0, 2, 21, 0, 0, 172, 198, 16, 0, 78, 21, 21, 0, 120, 21, 3, 0, 1, 10, 0, 0, 119, 0, 5, 0, 27, 21, 3, 36, 3, 21, 19, 21, 106, 21, 21, 24, 33, 10, 21, 0, 27, 21, 3, 36, 3, 8, 19, 21, 106, 22, 8, 32, 78, 22, 22, 0, 32, 22, 22, 0, 121, 22, 3, 0, 0, 21, 8, 0, 119, 0, 3, 0, 25, 22, 8, 4, 0, 21, 22, 0, 82, 4, 21, 0, 25, 5, 8, 20, 25, 6, 8, 16, 25, 7, 8, 12, 25, 8, 8, 8, 13, 21, 3, 13, 1, 22, 45, 0, 1, 23, 32, 0, 125, 9, 21, 22, 23, 0, 0, 0, 1, 12, 0, 0, 32, 1, 12, 4, 20, 23, 10, 1, 0, 11, 23, 0, 121, 11, 3, 0, 1, 0, 7, 0, 119, 0, 2, 0, 82, 0, 8, 0, 135, 23, 11, 0, 0, 0, 0, 0, 82, 22, 5, 0, 3, 22, 22, 12, 82, 21, 6, 0, 135, 23, 52, 0, 22, 21, 0, 0, 1, 22, 32, 0, 1, 24, 221, 255, 125, 21, 11, 22, 24, 0, 0, 0, 135, 23, 58, 0, 21, 0, 0, 0, 82, 0, 7, 0, 1, 23, 0, 0, 47, 23, 23, 0, 184, 72, 0, 0, 19, 23, 10, 1, 0, 2, 23, 0, 1, 1, 0, 0, 19, 23, 12, 18, 1, 21, 0, 0, 1, 24, 4, 0, 138, 23, 21, 24, 148, 72, 0, 0, 44, 72, 0, 0, 44, 72, 0, 0, 152, 72, 0, 0, 121, 2, 5, 0, 1, 24, 32, 0, 135, 21, 58, 0, 24, 0, 0, 0, 119, 0, 26, 0, 19, 21, 12, 18, 1, 24, 1, 0, 1, 22, 2, 0, 138, 21, 24, 22, 112, 72, 0, 0, 128, 72, 0, 0, 41, 22, 0, 1, 3, 22, 22, 1, 90, 22, 4, 22, 135, 24, 58, 0, 22, 0, 0, 0, 119, 0, 14, 0, 90, 22, 4, 1, 135, 24, 58, 0, 22, 0, 0, 0, 119, 0, 10, 0, 3, 22, 0, 1, 90, 22, 4, 22, 135, 24, 58, 0, 22, 0, 0, 0, 119, 0, 5, 0, 119, 0, 1, 0, 135, 21, 58, 0, 9, 0, 0, 0, 119, 0, 1, 0, 25, 1, 1, 1, 82, 0, 7, 0, 56, 23, 0, 1, 184, 72, 0, 0, 119, 0, 214, 255, 1, 24, 32, 0, 1, 22, 222, 255, 125, 21, 11, 24, 22, 0, 0, 0, 135, 23, 58, 0, 21, 0, 0, 0, 25, 12, 12, 1, 33, 23, 12, 5, 120, 23, 178, 255, 25, 3, 3, 1, 33, 23, 3, 10, 120, 23, 144, 255, 1, 21, 7, 0, 135, 23, 11, 0, 21, 0, 0, 0, 2, 23, 0, 0, 220, 211, 16, 0, 1, 21, 1, 0, 85, 23, 21, 0, 134, 5, 0, 0, 228, 227, 0, 0, 14, 15, 0, 0, 2, 21, 0, 0, 220, 211, 16, 0, 1, 23, 0, 0, 85, 21, 23, 0, 35, 0, 13, 8, 32, 1, 13, 8, 1, 23, 147, 0, 45, 23, 5, 23, 96, 73, 0, 0, 121, 0, 4, 0, 1, 21, 8, 0, 0, 23, 21, 0, 119, 0, 6, 0, 1, 22, 9, 0, 1, 24, 7, 0, 125, 21, 1, 22, 24, 0, 0, 0, 0, 23, 21, 0, 0, 1, 23, 0, 119, 0, 47, 0, 1, 23, 152, 0, 45, 23, 5, 23, 152, 73, 0, 0, 121, 0, 4, 0, 1, 21, 9, 0, 0, 23, 21, 0, 119, 0, 6, 0, 1, 24, 7, 0, 1, 22, 8, 0, 125, 21, 1, 24, 22, 0, 0, 0, 0, 23, 21, 0, 0, 1, 23, 0, 119, 0, 33, 0, 26, 0, 13, 1, 1, 23, 149, 0, 45, 23, 5, 23, 212, 73, 0, 0, 35, 21, 0, 7, 121, 21, 3, 0, 0, 23, 0, 0, 119, 0, 6, 0, 32, 22, 13, 0, 1, 24, 7, 0, 125, 21, 22, 24, 13, 0, 0, 0, 0, 23, 21, 0, 0, 1, 23, 0, 119, 0, 18, 0, 1, 21, 150, 0, 45, 21, 5, 21, 16, 74, 0, 0, 35, 24, 13, 7, 121, 24, 4, 0, 25, 24, 13, 1, 0, 21, 24, 0, 119, 0, 6, 0, 32, 22, 13, 7, 1, 25, 0, 0, 125, 24, 22, 25, 13, 0, 0, 0, 0, 21, 24, 0, 0, 23, 21, 0, 119, 0, 2, 0, 0, 23, 13, 0, 0, 1, 23, 0, 82, 2, 14, 0, 82, 3, 15, 0, 1, 0, 0, 0, 2, 23, 0, 0, 172, 198, 16, 0, 78, 23, 23, 0, 120, 23, 3, 0, 1, 16, 31, 0, 119, 0, 6, 0, 27, 23, 0, 36, 3, 23, 19, 23, 106, 23, 23, 24, 120, 23, 2, 0, 1, 16, 31, 0, 32, 23, 16, 31, 121, 23, 36, 2, 1, 16, 0, 0, 27, 23, 0, 36, 3, 23, 19, 23, 106, 23, 23, 28, 46, 23, 5, 23, 184, 82, 0, 0, 1, 23, 13, 0, 1, 21, 244, 1, 138, 5, 23, 21, 80, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 84, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0], eb + 10240);
    HEAPU8.set([76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 76, 82, 0, 0, 96, 82, 0, 0, 119, 0, 38, 0, 119, 0, 1, 0, 52, 23, 0, 1, 184, 82, 0, 0, 119, 0, 34, 0, 119, 0, 1, 0, 27, 23, 0, 36, 3, 23, 19, 23, 106, 4, 23, 16, 54, 23, 2, 4, 228, 82, 0, 0, 25, 23, 4, 2, 27, 21, 0, 36, 3, 21, 19, 21, 106, 21, 21, 12, 3, 23, 23, 21, 56, 23, 23, 2, 228, 82, 0, 0, 27, 23, 0, 36, 3, 23, 19, 23, 106, 13, 23, 20, 17, 23, 13, 3, 25, 21, 13, 4, 15, 21, 3, 21, 19, 23, 23, 21, 120, 23, 2, 0, 119, 0, 12, 0, 32, 23, 0, 9, 120, 23, 15, 0, 27, 23, 0, 36, 3, 23, 19, 23, 106, 13, 23, 32, 78, 23, 13, 0, 40, 23, 23, 1, 83, 13, 23, 0, 1, 21, 4, 0, 135, 23, 2, 0, 21, 0, 0, 0, 25, 0, 0, 1, 35, 23, 0, 10, 120, 23, 206, 253, 0, 13, 1, 0, 119, 0, 201, 252, 135, 23, 59, 0, 137, 17, 0, 0, 139, 0, 0, 0, 140, 2, 20, 0, 0, 0, 0, 0, 2, 14, 0, 0, 255, 0, 0, 0, 2, 15, 0, 0, 94, 200, 16, 0, 2, 16, 0, 0, 188, 200, 16, 0, 1, 12, 0, 0, 136, 17, 0, 0, 0, 13, 17, 0, 136, 17, 0, 0, 25, 17, 17, 32, 137, 17, 0, 0, 25, 11, 13, 16, 25, 3, 13, 8, 0, 2, 13, 0, 2, 17, 0, 0, 93, 200, 16, 0, 1, 18, 0, 0, 83, 17, 18, 0, 2, 18, 0, 0, 128, 200, 16, 0, 82, 18, 18, 0, 120, 18, 171, 1, 2, 18, 0, 0, 144, 200, 16, 0, 82, 2, 18, 0, 121, 2, 10, 0, 2, 18, 0, 0, 144, 200, 16, 0, 26, 17, 2, 1, 85, 18, 17, 0, 2, 18, 0, 0, 0, 139, 15, 0, 135, 17, 23, 0, 18, 3, 0, 0, 119, 0, 171, 1, 2, 17, 0, 0, 62, 4, 16, 0, 80, 17, 17, 0, 1, 18, 0, 1, 19, 17, 17, 18, 120, 17, 3, 0, 1, 12, 8, 0, 119, 0, 10, 0, 1, 18, 5, 0, 135, 17, 1, 0, 18, 0, 0, 0, 120, 17, 3, 0, 1, 12, 8, 0, 119, 0, 4, 0, 1, 18, 1, 0, 135, 17, 60, 0, 18, 16, 0, 0, 32, 17, 12, 8, 121, 17, 13, 0, 2, 17, 0, 0, 189, 200, 16, 0, 2, 18, 0, 0, 60, 4, 16, 0, 79, 18, 18, 0, 3, 18, 18, 0, 83, 17, 18, 0, 2, 18, 0, 0, 59, 4, 16, 0, 79, 18, 18, 0, 3, 18, 18, 1, 83, 16, 18, 0, 2, 18, 0, 0, 189, 200, 16, 0, 78, 0, 18, 0, 1, 18, 21, 0, 26, 17, 0, 1, 19, 17, 17, 14, 47, 18, 18, 17, 64, 84, 0, 0, 1, 12, 12, 0, 119, 0, 238, 0, 78, 2, 16, 0, 1, 18, 79, 0, 19, 17, 2, 14, 47, 18, 18, 17, 92, 84, 0, 0, 1, 12, 12, 0, 119, 0, 231, 0, 2, 17, 0, 0, 59, 4, 16, 0, 135, 18, 61, 0, 17, 16, 0, 0, 120, 18, 3, 0, 1, 12, 15, 0, 119, 0, 231, 0, 2, 18, 0, 0, 59, 4, 16, 0, 78, 1, 18, 0, 2, 18, 0, 0, 60, 4, 16, 0, 78, 3, 18, 0, 78, 17, 15, 0, 121, 17, 8, 0, 41, 17, 1, 24, 42, 17, 17, 24, 41, 19, 2, 24, 42, 19, 19, 24, 13, 17, 17, 19, 0, 18, 17, 0, 119, 0, 3, 0, 1, 17, 0, 0, 0, 18, 17, 0, 41, 17, 3, 24, 42, 17, 17, 24, 41, 19, 0, 24, 42, 19, 19, 24, 13, 17, 17, 19, 19, 18, 18, 17, 121, 18, 7, 0, 1, 18, 0, 0, 83, 15, 18, 0, 2, 18, 0, 0, 76, 200, 16, 0, 1, 17, 0, 0, 83, 18, 17, 0, 41, 17, 2, 24, 42, 17, 17, 24, 0, 9, 17, 0, 41, 17, 0, 24, 42, 17, 17, 24, 0, 4, 17, 0, 26, 17, 4, 1, 27, 18, 9, 22, 3, 5, 17, 18, 2, 18, 0, 0, 160, 54, 16, 0, 3, 6, 18, 5, 78, 7, 6, 0, 19, 18, 7, 14, 0, 10, 18, 0, 135, 0, 33, 0, 4, 9, 0, 0, 19, 18, 0, 14, 0, 8, 18, 0, 41, 18, 3, 24, 42, 18, 18, 24, 26, 18, 18, 1, 41, 17, 1, 24, 42, 17, 17, 24, 27, 17, 17, 22, 3, 2, 18, 17, 19, 17, 0, 14, 0, 0, 17, 0, 1, 17, 250, 0, 13, 1, 0, 17, 2, 17, 0, 0, 128, 61, 16, 0, 90, 17, 17, 2, 32, 17, 17, 206, 19, 17, 1, 17, 121, 17, 3, 0, 1, 17, 0, 0, 83, 15, 17, 0, 38, 17, 10, 16, 33, 3, 17, 0, 40, 17, 3, 1, 19, 17, 1, 17, 121, 17, 3, 0, 1, 12, 21, 0, 119, 0, 156, 0, 32, 17, 0, 70, 2, 18, 0, 0, 62, 4, 16, 0, 80, 18, 18, 0, 1, 19, 128, 0, 19, 18, 18, 19, 32, 18, 18, 0, 20, 17, 17, 18, 120, 17, 3, 0, 1, 12, 23, 0, 119, 0, 145, 0, 41, 17, 8, 24, 42, 17, 17, 24, 1, 18, 177, 255, 1, 19, 112, 0, 138, 17, 18, 19, 172, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 180, 87, 0, 0, 184, 87, 0, 0, 188, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 192, 87, 0, 0, 196, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 200, 87, 0, 0, 204, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 212, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 220, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 164, 87, 0, 0, 224, 87, 0, 0, 1, 12, 38, 0, 119, 0, 26, 0, 1, 12, 34, 0, 119, 0, 24, 0, 119, 0, 12, 0, 119, 0, 11, 0, 119, 0, 10, 0, 119, 0, 9, 0, 119, 0, 8, 0, 119, 0, 7, 0, 1, 12, 28, 0, 119, 0, 16, 0, 1, 12, 35, 0, 119, 0, 14, 0, 119, 0, 13, 0, 119, 0, 1, 0, 135, 17, 62, 0, 120, 17, 3, 0, 1, 12, 27, 0, 119, 0, 8, 0, 32, 17, 12, 12, 121, 17, 8, 255, 1, 12, 0, 0, 135, 17, 62, 0, 120, 17, 5, 255, 1, 12, 13, 0, 119, 0, 1, 0, 32, 17, 12, 13, 121, 17, 8, 0, 1, 17, 0, 0, 83, 15, 17, 0, 2, 17, 0, 0, 76, 200, 16, 0, 1, 18, 0, 0, 83, 17, 18, 0, 119, 0, 133, 0, 32, 18, 12, 15, 121, 18, 8, 0, 1, 18, 0, 0, 83, 15, 18, 0, 2, 18, 0, 0, 76, 200, 16, 0, 1, 17, 0, 0, 83, 18, 17, 0, 119, 0, 124, 0, 32, 17, 12, 21, 121, 17, 8, 0, 2, 17, 0, 0, 128, 61, 16, 0, 1, 18, 4, 0, 95, 17, 5, 18, 39, 18, 7, 16, 83, 6, 18, 0, 119, 0, 78, 0, 32, 18, 12, 23, 121, 18, 6, 0, 2, 17, 0, 0, 38, 139, 15, 0, 135, 18, 23, 0, 17, 11, 0, 0, 119, 0, 108, 0, 32, 18, 12, 27, 121, 18, 8, 0, 1, 18, 0, 0, 83, 15, 18, 0, 2, 18, 0, 0, 76, 200, 16, 0, 1, 17, 0, 0, 83, 18, 17, 0, 119, 0, 99, 0, 32, 17, 12, 28, 121, 17, 13, 0, 1, 17, 0, 0, 83, 15, 17, 0, 2, 17, 0, 0, 160, 54, 16, 0, 90, 17, 17, 2, 38, 17, 17, 64, 121, 17, 3, 0, 135, 17, 63, 0, 16, 0, 0, 0, 135, 17, 64, 0, 10, 0, 0, 0, 119, 0, 85, 0, 32, 17, 12, 34, 121, 17, 4, 0, 135, 17, 64, 0, 10, 0, 0, 0, 119, 0, 80, 0, 32, 17, 12, 35, 121, 17, 14, 0, 120, 3, 10, 0, 2, 18, 0, 0, 59, 4, 16, 0, 134, 17, 0, 0, 76, 90, 0, 0, 18, 0, 0, 0, 2, 17, 0, 0, 74, 200, 16, 0, 78, 17, 17, 0, 120, 17, 68, 0, 135, 17, 64, 0, 10, 0, 0, 0, 119, 0, 65, 0, 32, 17, 12, 38, 121, 17, 26, 0, 1, 17, 0, 0, 83, 15, 17, 0, 135, 17, 65, 0, 0, 0, 0, 0, 120, 17, 14, 0, 135, 17, 34, 0, 4, 9, 0, 0, 120, 17, 11, 0, 41, 17, 8, 24, 42, 17, 17, 24, 33, 17, 17, 240, 121, 17, 4, 0, 2, 17, 0, 0, 80, 200, 16, 0, 83, 17, 8, 0, 135, 17, 64, 0, 10, 0, 0, 0, 119, 0, 45, 0, 2, 18, 0, 0, 98, 200, 16, 0, 79, 18, 18, 0, 1, 19, 0, 0, 135, 17, 66, 0, 16, 8, 18, 19, 119, 0, 38, 0, 134, 2, 0, 0, 76, 90, 0, 0, 16, 0, 0, 0, 2, 17, 0, 0, 74, 200, 16, 0, 78, 17, 17, 0, 120, 17, 31, 0, 19, 17, 2, 14, 41, 17, 17, 24, 42, 17, 17, 24, 1, 19, 0, 0, 1, 18, 5, 0, 138, 17, 19, 18, 252, 89, 0, 0, 248, 89, 0, 0, 248, 89, 0, 0, 248, 89, 0, 0, 0, 90, 0, 0, 119, 0, 3, 0, 119, 0, 18, 0, 119, 0, 17, 0, 135, 17, 64, 0, 10, 0, 0, 0, 119, 0, 14, 0, 2, 17, 0, 0, 128, 200, 16, 0, 1, 19, 0, 0, 85, 17, 19, 0, 2, 17, 0, 0, 236, 138, 15, 0, 135, 19, 23, 0, 17, 2, 0, 0, 2, 17, 0, 0, 162, 236, 16, 0, 134, 19, 0, 0, 200, 224, 0, 0, 17, 0, 0, 0, 137, 13, 0, 0, 139, 0, 0, 0, 140, 1, 20, 0, 0, 0, 0, 0, 2, 12, 0, 0, 192, 3, 16, 0, 2, 13, 0, 0, 255, 0, 0, 0, 2, 14, 0, 0, 100, 200, 16, 0, 1, 9, 0, 0, 136, 15, 0, 0, 0, 10, 15, 0, 136, 15, 0, 0, 25, 15, 15, 64, 137, 15, 0, 0, 25, 3, 10, 56, 25, 8, 10, 48, 25, 6, 10, 40, 25, 7, 10, 32, 25, 5, 10, 24, 25, 4, 10, 16, 2, 15, 0, 0, 94, 200, 16, 0, 1, 16, 0, 0, 83, 15, 16, 0, 2, 16, 0, 0, 112, 200, 16, 0, 1, 15, 0, 0, 85, 16, 15, 0, 25, 2, 0, 1, 78, 15, 2, 0, 26, 15, 15, 1, 78, 16, 0, 0, 27, 16, 16, 22, 3, 11, 15, 16, 2, 16, 0, 0, 128, 61, 16, 0, 1, 15, 4, 0, 95, 16, 11, 15, 2, 15, 0, 0, 160, 54, 16, 0, 90, 11, 15, 11, 2, 15, 0, 0, 95, 200, 16, 0, 1, 16, 1, 0, 83, 15, 16, 0, 38, 16, 11, 7, 0, 1, 16, 0, 38, 16, 11, 7, 1, 17, 0, 0, 1, 18, 6, 0, 138, 16, 17, 18, 56, 91, 0, 0, 120, 91, 0, 0, 216, 92, 0, 0, 68, 93, 0, 0, 144, 93, 0, 0, 212, 93, 0, 0, 1, 9, 24, 0, 119, 0, 255, 0, 1, 17, 26, 0, 135, 15, 2, 0, 17, 0, 0, 0, 2, 17, 0, 0, 58, 139, 15, 0, 134, 15, 0, 0, 200, 224, 0, 0, 17, 0, 0, 0, 2, 15, 0, 0, 74, 200, 16, 0, 78, 15, 15, 0, 120, 15, 3, 0, 1, 9, 24, 0, 119, 0, 241, 0, 1, 1, 0, 0, 119, 0, 239, 0, 1, 18, 21, 0, 135, 17, 2, 0, 18, 0, 0, 0, 2, 18, 0, 0, 84, 4, 16, 0, 82, 18, 18, 0, 26, 18, 18, 1, 2, 15, 0, 0, 88, 4, 16, 0, 82, 15, 15, 0, 1, 19, 1, 0, 135, 17, 67, 0, 18, 15, 19, 0, 120, 17, 40, 0, 135, 11, 37, 0, 19, 17, 11, 13, 0, 0, 17, 0, 41, 17, 11, 24, 42, 17, 17, 24, 121, 17, 28, 0, 27, 17, 0, 120, 3, 11, 12, 17, 1, 19, 24, 0, 107, 11, 77, 19, 1, 17, 3, 0, 107, 11, 79, 17, 1, 19, 3, 0, 135, 17, 68, 0, 0, 19, 0, 0, 1, 19, 1, 0, 109, 11, 100, 19, 25, 11, 11, 3, 2, 19, 0, 0, 59, 4, 16, 0, 79, 19, 19, 0, 2, 17, 0, 0, 60, 4, 16, 0, 79, 17, 17, 0, 41, 17, 17, 8, 20, 19, 19, 17, 0, 9, 19, 0, 83, 11, 9, 0, 42, 17, 9, 8, 107, 11, 1, 17, 1, 19, 0, 0, 135, 17, 69, 0, 0, 19, 0, 0, 2, 19, 0, 0, 213, 139, 15, 0, 135, 17, 23, 0, 19, 7, 0, 0, 1, 9, 24, 0, 119, 0, 186, 0, 1, 17, 1, 0, 1, 19, 6, 0, 135, 11, 31, 0, 17, 19, 0, 0, 2, 19, 0, 0, 92, 4, 16, 0, 82, 19, 19, 0, 4, 11, 19, 11, 2, 19, 0, 0, 92, 4, 16, 0, 85, 19, 11, 0, 34, 19, 11, 1, 121, 19, 17, 0, 2, 17, 0, 0, 166, 139, 15, 0, 135, 19, 23, 0, 17, 4, 0, 0, 1, 17, 97, 0, 134, 19, 0, 0, 120, 137, 0, 0, 17, 0, 0, 0, 2, 19, 0, 0, 74, 200, 16, 0, 78, 19, 19, 0, 120, 19, 3, 0, 1, 9, 24, 0, 119, 0, 159, 0, 1, 1, 0, 0, 119, 0, 157, 0, 2, 17, 0, 0, 187, 139, 15, 0, 135, 19, 23, 0, 17, 5, 0, 0, 1, 9, 24, 0, 119, 0, 151, 0, 1, 15, 10, 0, 135, 17, 2, 0, 15, 0, 0, 0, 1, 17, 5, 0, 135, 9, 39, 0, 17, 0, 0, 0, 2, 17, 0, 0, 148, 200, 16, 0, 2, 15, 0, 0, 148, 200, 16, 0, 82, 15, 15, 0, 3, 15, 15, 9, 85, 17, 15, 0, 2, 15, 0, 0, 62, 4, 16, 0, 2, 17, 0, 0, 62, 4, 16, 0, 80, 17, 17, 0, 38, 17, 17, 251, 84, 15, 17, 0, 2, 15, 0, 0, 111, 139, 15, 0, 25, 18, 10, 8, 135, 17, 23, 0, 15, 18, 0, 0, 1, 9, 24, 0, 119, 0, 124, 0, 1, 17, 1, 0, 135, 15, 2, 0, 17, 0, 0, 0, 1, 15, 3, 0, 135, 9, 39, 0, 15, 0, 0, 0, 2, 15, 0, 0, 144, 200, 16, 0, 2, 17, 0, 0, 144, 200, 16, 0, 82, 17, 17, 0, 3, 17, 17, 9, 85, 15, 17, 0, 2, 15, 0, 0, 80, 139, 15, 0, 135, 17, 23, 0, 15, 10, 0, 0, 1, 9, 24, 0, 119, 0, 105, 0, 135, 19, 70, 0, 78, 17, 2, 0, 78, 15, 0, 0, 1, 18, 4, 0, 135, 19, 8, 0, 17, 15, 18, 0, 2, 19, 0, 0, 95, 200, 16, 0, 2, 18, 0, 0, 95, 200, 16, 0, 78, 18, 18, 0, 25, 18, 18, 1, 41, 18, 18, 24, 42, 18, 18, 24, 83, 19, 18, 0, 1, 9, 24, 0, 119, 0, 88, 0, 1, 19, 21, 0, 135, 18, 2, 0, 19, 0, 0, 0, 2, 19, 0, 0, 84, 4, 16, 0, 82, 19, 19, 0, 25, 19, 19, 1, 2, 15, 0, 0, 88, 4, 16, 0, 82, 15, 15, 0, 1, 17, 1, 0, 135, 18, 67, 0, 19, 15, 17, 0, 120, 18, 7, 0, 2, 17, 0, 0, 48, 140, 15, 0, 135, 18, 23, 0, 17, 3, 0, 0, 1, 9, 24, 0, 119, 0, 68, 0, 1, 18, 1, 0, 1, 17, 4, 0, 135, 11, 31, 0, 18, 17, 0, 0, 2, 17, 0, 0, 92, 4, 16, 0, 82, 17, 17, 0, 4, 11, 17, 11, 2, 17, 0, 0, 92, 4, 16, 0, 85, 17, 11, 0, 34, 17, 11, 1, 121, 17, 15, 0, 2, 18, 0, 0, 239, 139, 15, 0, 135, 17, 23, 0, 18, 6, 0, 0, 1, 18, 100, 0, 134, 17, 0, 0, 120, 137, 0, 0, 18, 0, 0, 0, 2, 17, 0, 0, 74, 200, 16, 0, 78, 17, 17, 0, 121, 17, 3, 0, 1, 1, 0, 0, 119, 0, 41, 0, 2, 17, 0, 0, 99, 200, 16, 0, 78, 0, 17, 0, 41, 17, 0, 24, 42, 17, 17, 24, 120, 17, 3, 0, 1, 9, 18, 0, 119, 0, 8, 0, 19, 17, 0, 13, 27, 17, 17, 120, 3, 17, 12, 17, 102, 17, 17, 79, 33, 17, 17, 2, 121, 17, 2, 0, 1, 9, 18, 0, 32, 17, 9, 18, 121, 17, 18, 0, 78, 0, 14, 0, 41, 17, 0, 24, 42, 17, 17, 24, 121, 17, 7, 0, 19, 17, 0, 13, 27, 17, 17, 120, 3, 17, 12, 17, 102, 17, 17, 79, 32, 17, 17, 2, 120, 17, 8, 0, 1, 18, 0, 0, 135, 17, 25, 0, 18, 0, 0, 0, 120, 17, 4, 0, 1, 18, 255, 255, 135, 17, 30, 0, 18, 0, 0, 0, 2, 18, 0, 0, 11, 140, 15, 0, 135, 17, 23, 0, 18, 8, 0, 0, 1, 9, 24, 0, 119, 0, 1, 0, 137, 10, 0, 0, 139, 1, 0, 0, 140, 0, 13, 0, 0, 0, 0, 0, 2, 5, 0, 0, 76, 200, 16, 0, 2, 6, 0, 0, 192, 3, 16, 0, 2, 7, 0, 0, 19, 204, 16, 0, 136, 8, 0, 0, 0, 4, 8, 0, 136, 8, 0, 0, 25, 8, 8, 16, 137, 8, 0, 0, 25, 2, 4, 8, 0, 1, 4, 0, 2, 8, 0, 0, 233, 124, 15, 0, 1, 9, 231, 0, 134, 3, 0, 0, 60, 213, 0, 0, 8, 9, 0, 0, 121, 3, 222, 0, 27, 9, 3, 120, 3, 9, 6, 9, 102, 9, 9, 77, 32, 9, 9, 231, 121, 9, 12, 0, 27, 9, 3, 120, 3, 0, 6, 9, 103, 1, 0, 79, 25, 0, 0, 116, 82, 9, 0, 0, 120, 9, 24, 0, 2, 8, 0, 0, 11, 125, 15, 0, 135, 9, 23, 0, 8, 2, 0, 0, 119, 0, 206, 0, 27, 9, 3, 120, 3, 9, 6, 9, 102, 9, 9, 81, 121, 9, 8, 0, 27, 9, 3, 120, 3, 9, 6, 9, 25, 0, 9, 116, 82, 9, 0, 0, 121, 9, 3, 0, 1, 1, 14, 0, 119, 0, 8, 0, 2, 8, 0, 0, 242, 124, 15, 0, 135, 9, 23, 0, 8, 1, 0, 0, 1, 9, 0, 0, 83, 5, 9, 0, 119, 0, 188, 0, 1, 9, 255, 0, 19, 9, 1, 9, 41, 9, 9, 24, 42, 9, 9, 24, 1, 8, 0, 0, 1, 10, 15, 0, 138, 9, 8, 10, 116, 96, 0, 0, 132, 96, 0, 0, 148, 96, 0, 0, 28, 97, 0, 0, 164, 97, 0, 0, 52, 98, 0, 0, 68, 98, 0, 0, 84, 98, 0, 0, 100, 98, 0, 0, 116, 98, 0, 0, 132, 98, 0, 0, 196, 98, 0, 0, 212, 98, 0, 0, 228, 98, 0, 0, 244, 98, 0, 0, 119, 0, 165, 0, 134, 8, 0, 0, 60, 216, 0, 0, 3, 0, 0, 0, 119, 0, 161, 0, 134, 8, 0, 0, 236, 207, 0, 0, 3, 0, 0, 0, 119, 0, 157, 0, 134, 8, 0, 0, 100, 203, 0, 0, 120, 8, 4, 0, 1, 8, 0, 0, 83, 5, 8, 0, 119, 0, 151, 0, 1, 10, 28, 0, 135, 8, 2, 0, 10, 0, 0, 0, 2, 10, 0, 0, 59, 4, 16, 0, 2, 11, 0, 0, 186, 200, 16, 0, 2, 12, 0, 0, 176, 119, 15, 0, 134, 8, 0, 0, 248, 34, 0, 0, 10, 11, 12, 0, 2, 8, 0, 0, 74, 200, 16, 0, 78, 8, 8, 0, 120, 8, 135, 0, 1, 12, 1, 0, 95, 7, 1, 12, 82, 3, 0, 0, 34, 8, 3, 1, 121, 8, 4, 0, 1, 8, 0, 0, 0, 12, 8, 0, 119, 0, 3, 0, 26, 8, 3, 1, 0, 12, 8, 0, 85, 0, 12, 0, 119, 0, 123, 0, 134, 12, 0, 0, 100, 203, 0, 0, 120, 12, 4, 0, 1, 12, 0, 0, 83, 5, 12, 0, 119, 0, 117, 0, 1, 8, 8, 0, 135, 12, 2, 0, 8, 0, 0, 0, 2, 8, 0, 0, 59, 4, 16, 0, 2, 11, 0, 0, 186, 200, 16, 0, 2, 10, 0, 0, 53, 115, 15, 0, 134, 12, 0, 0, 248, 34, 0, 0, 8, 11, 10, 0, 2, 12, 0, 0, 74, 200, 16, 0, 78, 12, 12, 0, 120, 12, 101, 0, 1, 10, 1, 0, 95, 7, 1, 10, 82, 3, 0, 0, 34, 12, 3, 1, 121, 12, 4, 0, 1, 12, 0, 0, 0, 10, 12, 0, 119, 0, 3, 0, 26, 12, 3, 1, 0, 10, 12, 0, 85, 0, 10, 0, 119, 0, 89, 0, 134, 10, 0, 0, 100, 203, 0, 0, 120, 10, 4, 0, 1, 10, 0, 0, 83, 5, 10, 0, 119, 0, 83, 0, 1, 12, 14, 0, 135, 10, 2, 0, 12, 0, 0, 0, 2, 12, 0, 0, 59, 4, 16, 0, 2, 11, 0, 0, 186, 200, 16, 0, 2, 8, 0, 0, 28, 125, 15, 0, 134, 10, 0, 0, 248, 34, 0, 0, 12, 11, 8, 0, 2, 10, 0, 0, 74, 200, 16, 0, 78, 10, 10, 0, 120, 10, 67, 0, 1, 8, 1, 0, 95, 7, 1, 8, 82, 3, 0, 0, 34, 10, 3, 1, 121, 10, 4, 0, 1, 10, 0, 0, 0, 8, 10, 0, 119, 0, 3, 0, 26, 10, 3, 1, 0, 8, 10, 0, 85, 0, 8, 0, 137, 4, 0, 0, 139, 0, 0, 0, 119, 0, 53, 0, 134, 8, 0, 0, 32, 143, 0, 0, 3, 0, 0, 0, 119, 0, 49, 0, 134, 8, 0, 0, 8, 177, 0, 0, 3, 0, 0, 0, 119, 0, 45, 0, 134, 8, 0, 0, 68, 209, 0, 0, 3, 0, 0, 0, 119, 0, 41, 0, 134, 8, 0, 0, 224, 204, 0, 0, 3, 0, 0, 0, 119, 0, 37, 0, 134, 8, 0, 0, 24, 106, 0, 0, 3, 0, 0, 0, 119, 0, 33, 0, 134, 8, 0, 0, 100, 203, 0, 0, 120, 8, 4, 0, 1, 8, 0, 0, 83, 5, 8, 0, 119, 0, 27, 0, 82, 3, 0, 0, 34, 10, 3, 1, 121, 10, 4, 0, 1, 10, 0, 0, 0, 8, 10, 0, 119, 0, 3, 0, 26, 10, 3, 1, 0, 8, 10, 0, 85, 0, 8, 0, 119, 0, 17, 0, 134, 8, 0, 0, 160, 157, 0, 0, 3, 0, 0, 0, 119, 0, 13, 0, 134, 8, 0, 0, 88, 184, 0, 0, 3, 0, 0, 0, 119, 0, 9, 0, 134, 8, 0, 0, 144, 210, 0, 0, 3, 0, 0, 0, 119, 0, 5, 0, 134, 8, 0, 0, 236, 178, 0, 0, 3, 0, 0, 0, 119, 0, 1, 0, 137, 4, 0, 0, 139, 0, 0, 0, 140, 0, 13, 0, 0, 0, 0, 0, 2, 6, 0, 0, 128, 61, 16, 0, 2, 7, 0, 0, 59, 4, 16, 0, 2, 8, 0, 0, 160, 54, 16, 0, 136, 9, 0, 0, 0, 4, 9, 0, 136, 9, 0, 0, 25, 9, 9, 16, 137, 9, 0, 0, 0, 3, 4, 0, 1, 10, 1, 0, 1, 11, 0, 0, 134, 9, 0, 0, 84, 163, 0, 0, 10, 11, 0, 0, 2, 9, 0, 0, 62, 4, 16, 0, 2, 11, 0, 0, 62, 4, 16, 0, 80, 11, 11, 0, 1, 10, 127, 255, 19, 11, 11, 10, 84, 9, 11, 0, 135, 11, 71, 0, 2, 11, 0, 0, 136, 200, 16, 0, 82, 0, 11, 0, 2, 11, 0, 0, 132, 200, 16, 0, 82, 11, 11, 0, 47, 11, 11, 0, 168, 99, 0, 0, 2, 11, 0, 0, 132, 200, 16, 0, 85, 11, 0, 0, 1, 9, 32, 0, 1, 10, 224, 6, 135, 11, 72, 0, 6, 9, 10, 0, 1, 10, 16, 0, 1, 9, 224, 6, 135, 11, 72, 0, 8, 10, 9, 0, 2, 11, 0, 0, 73, 200, 16, 0, 78, 0, 11, 0, 41, 11, 0, 24, 42, 11, 11, 24, 121, 11, 20, 0, 1, 11, 255, 0, 19, 11, 0, 11, 0, 0, 11, 0, 2, 11, 0, 0, 192, 3, 16, 0, 27, 9, 0, 120, 3, 0, 11, 9, 25, 11, 0, 8, 135, 9, 73, 0, 11, 0, 0, 0, 102, 0, 0, 1, 41, 9, 0, 24, 42, 9, 9, 24, 120, 9, 2, 0, 119, 0, 5, 0, 1, 9, 255, 0, 19, 9, 0, 9, 0, 0, 9, 0, 119, 0, 241, 255, 2, 11, 0, 0, 73, 200, 16, 0, 135, 9, 73, 0, 11, 0, 0, 0, 2, 11, 0, 0, 72, 200, 16, 0, 135, 9, 73, 0, 11, 0, 0, 0, 135, 9, 74, 0, 135, 9, 75, 0, 2, 9, 0, 0, 160, 200, 16, 0, 2, 11, 0, 0, 160, 200, 16, 0, 82, 11, 11, 0, 25, 11, 11, 1, 85, 9, 11, 0, 135, 11, 76, 0, 25, 2, 3, 1, 135, 9, 77, 0, 135, 11, 78, 0, 9, 3, 0, 0, 78, 11, 2, 0, 26, 11, 11, 1, 78, 9, 3, 0, 27, 9, 9, 22, 3, 11, 11, 9, 3, 0, 6, 11, 78, 11, 0, 0, 1, 9, 177, 255, 1, 10, 74, 0, 138, 11, 9, 10, 216, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 212, 101, 0, 0, 220, 101, 0, 0, 119, 0, 169, 255, 119, 0, 2, 0, 119, 0, 1, 0, 1, 11, 240, 255, 83, 0, 11, 0, 1, 11, 10, 0, 135, 1, 1, 0, 11, 0, 0, 0, 2, 11, 0, 0, 136, 200, 16, 0, 82, 0, 11, 0, 47, 11, 1, 0, 208, 103, 0, 0, 28, 11, 0, 4, 135, 0, 1, 0, 11, 0, 0, 0, 34, 9, 0, 9, 121, 9, 4, 0, 25, 9, 0, 1, 0, 11, 9, 0, 119, 0, 3, 0, 1, 9, 10, 0, 0, 11, 9, 0, 0, 0, 11, 0, 121, 0, 103, 0, 26, 0, 0, 1, 135, 9, 77, 0, 135, 11, 78, 0, 9, 3, 0, 0, 78, 11, 2, 0, 26, 11, 11, 1, 78, 9, 3, 0, 27, 9, 9, 22, 3, 1, 11, 9, 90, 9, 6, 1, 1, 11, 177, 255, 1, 10, 74, 0, 138, 9, 11, 10, 152, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 148, 103, 0, 0, 156, 103, 0, 0, 119, 0, 170, 255, 119, 0, 2, 0, 119, 0, 1, 0, 3, 1, 8, 1, 78, 9, 1, 0, 38, 9, 9, 232, 83, 1, 9, 0, 1, 9, 6, 0, 135, 5, 1, 0, 9, 0, 0, 0, 79, 9, 1, 0, 20, 9, 5, 9, 83, 1, 9, 0, 33, 9, 0, 0, 120, 9, 155, 255, 135, 11, 77, 0, 135, 9, 78, 0, 11, 7, 0, 0, 78, 0, 7, 0, 2, 9, 0, 0, 60, 4, 16, 0, 78, 1, 9, 0, 26, 9, 1, 1, 27, 11, 0, 22, 3, 2, 9, 11, 90, 11, 6, 2, 1, 9, 177, 255, 1, 10, 74, 0, 138, 11, 9, 10, 52, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 48, 105, 0, 0, 56, 105, 0, 0, 119, 0, 168, 255, 119, 0, 1, 0, 90, 9, 8, 2, 38, 9, 9, 16, 121, 9, 164, 255, 135, 9, 34, 0, 1, 0, 0, 0, 120, 9, 161, 255, 119, 0, 1, 0, 1, 9, 1, 0, 135, 11, 49, 0, 9, 0, 0, 0, 135, 11, 63, 0, 7, 0, 0, 0, 2, 9, 0, 0, 60, 4, 16, 0, 78, 9, 9, 0, 78, 10, 7, 0, 1, 12, 1, 0, 135, 11, 8, 0, 9, 10, 12, 0, 2, 11, 0, 0, 184, 200, 16, 0, 78, 12, 7, 0, 83, 11, 12, 0, 2, 12, 0, 0, 185, 200, 16, 0, 2, 11, 0, 0, 60, 4, 16, 0, 78, 11, 11, 0, 83, 12, 11, 0, 135, 11, 0, 0, 7, 0, 0, 0, 1, 12, 255, 0, 19, 11, 11, 12, 0, 5, 11, 0, 2, 11, 0, 0, 96, 200, 16, 0, 83, 11, 5, 0, 2, 11, 0, 0, 62, 4, 16, 0, 80, 11, 11, 0, 38, 11, 11, 2, 121, 11, 4, 0, 1, 12, 0, 0, 135, 11, 79, 0, 12, 0, 0, 0, 1, 12, 0, 0, 135, 11, 14, 0, 12, 0, 0, 0, 135, 11, 51, 0, 1, 12, 0, 0, 1, 10, 0, 0, 134, 11, 0, 0, 84, 163, 0, 0, 12, 10, 0, 0, 137, 4, 0, 0, 139, 0, 0, 0, 140, 1, 17, 0, 0, 0, 0, 0, 2, 11, 0, 0, 192, 3, 16, 0, 2, 12, 0, 0, 255, 0, 0, 0, 2, 13, 0, 0, 128, 0, 0, 0, 1, 9, 0, 0, 136, 14, 0, 0, 0, 10, 14, 0, 136, 14, 0, 0, 1, 15, 16, 2, 3, 14, 14, 15, 137, 14, 0, 0, 1, 14, 8, 2, 3, 7, 10, 14, 0, 8, 10, 0, 2, 14, 0, 0, 92, 4, 16, 0, 82, 14, 14, 0, 34, 14, 14, 2, 121, 14, 9, 0, 2, 15, 0, 0, 156, 125, 15, 0, 1, 16, 0, 2, 3, 16, 10, 16, 135, 14, 23, 0, 15, 16, 0, 0, 137, 10, 0, 0, 139, 0, 0, 0, 2, 14, 0, 0, 28, 204, 16, 0, 78, 14, 14, 0, 120, 14, 11, 0, 134, 14, 0, 0, 100, 203, 0, 0, 120, 14, 6, 0, 2, 14, 0, 0, 76, 200, 16, 0, 1, 16, 0, 0, 83, 14, 16, 0, 119, 0, 4, 0, 1, 9, 6, 0, 119, 0, 2, 0, 1, 9, 6, 0, 32, 16, 9, 6, 121, 16, 178, 0, 2, 16, 0, 0, 60, 4, 16, 0, 78, 16, 16, 0, 26, 16, 16, 1, 2, 14, 0, 0, 59, 4, 16, 0, 78, 14, 14, 0, 27, 14, 14, 22, 3, 1, 16, 14, 2, 14, 0, 0, 128, 61, 16, 0, 90, 14, 14, 1, 32, 14, 14, 206, 121, 14, 9, 0, 2, 14, 0, 0, 160, 54, 16, 0, 90, 14, 14, 1, 38, 14, 14, 15, 25, 14, 14, 10, 19, 14, 14, 12, 0, 4, 14, 0, 119, 0, 2, 0, 1, 4, 0, 0, 2, 14, 0, 0, 69, 4, 16, 0, 78, 5, 14, 0, 2, 14, 0, 0, 73, 200, 16, 0, 78, 2, 14, 0, 41, 14, 2, 24, 42, 14, 14, 24, 120, 14, 3, 0, 1, 9, 17, 0, 119, 0, 126, 0, 2, 14, 0, 0, 160, 50, 16, 0, 19, 16, 5, 12, 27, 16, 16, 44, 90, 14, 14, 16, 38, 14, 14, 2, 32, 6, 14, 0, 1, 1, 0, 0, 19, 14, 2, 12, 0, 3, 14, 0, 27, 14, 3, 120, 3, 14, 11, 14, 102, 2, 14, 13, 19, 16, 2, 12, 45, 16, 4, 16, 172, 107, 0, 0, 1, 16, 1, 0, 0, 14, 16, 0, 119, 0, 7, 0, 41, 16, 2, 24, 42, 16, 16, 24, 41, 15, 5, 24, 42, 15, 15, 24, 13, 16, 16, 15, 0, 14, 16, 0, 121, 14, 3, 0, 1, 9, 14, 0, 119, 0, 28, 0, 120, 6, 27, 0, 27, 14, 3, 120, 3, 2, 11, 14, 102, 14, 2, 4, 26, 14, 14, 1, 102, 16, 2, 3, 27, 16, 16, 22, 3, 2, 14, 16, 2, 16, 0, 0, 128, 61, 16, 0, 90, 16, 16, 2, 32, 16, 16, 206, 121, 16, 15, 0, 2, 16, 0, 0, 160, 54, 16, 0, 90, 16, 16, 2, 38, 16, 16, 15, 25, 16, 16, 10, 41, 16, 16, 24, 42, 16, 16, 24, 41, 16, 16, 24, 42, 16, 16, 24, 41, 14, 5, 24, 42, 14, 14, 24, 45, 16, 16, 14, 60, 108, 0, 0, 1, 9, 14, 0, 32, 16, 9, 14, 121, 16, 10, 0, 1, 9, 0, 0, 25, 2, 1, 1, 41, 16, 1, 2, 97, 8, 16, 3, 45, 16, 2, 13, 100, 108, 0, 0, 1, 1, 128, 0, 119, 0, 13, 0, 0, 1, 2, 0, 27, 16, 3, 120, 3, 16, 11, 16, 102, 2, 16, 1, 41, 16, 2, 24, 42, 16, 16, 24, 120, 16, 3, 0, 1, 9, 16, 0, 119, 0, 4, 0, 19, 16, 2, 12, 0, 3, 16, 0, 119, 0, 190, 255, 32, 16, 9, 16, 121, 16, 4, 0, 120, 1, 3, 0, 1, 9, 17, 0, 119, 0, 44, 0, 2, 16, 0, 0, 92, 4, 16, 0, 82, 16, 16, 0, 28, 3, 16, 2, 2, 16, 0, 0, 92, 4, 16, 0, 85, 16, 3, 0, 6, 3, 3, 1, 47, 14, 3, 1, 220, 108, 0, 0, 25, 14, 3, 1, 0, 16, 14, 0, 119, 0, 2, 0, 0, 16, 1, 0, 0, 3, 16, 0, 1, 16, 0, 0, 47, 16, 16, 3, 84, 109, 0, 0, 1, 1, 0, 0, 41, 16, 1, 2, 94, 2, 8, 16, 27, 16, 2, 120, 3, 16, 11, 16, 25, 6, 16, 36, 82, 16, 6, 0, 4, 7, 16, 3, 85, 6, 7, 0, 34, 16, 7, 1, 121, 16, 7, 0, 135, 14, 10, 0, 2, 0, 0, 0, 19, 14, 14, 12, 135, 16, 80, 0, 2, 14, 0, 0, 119, 0, 6, 0, 27, 14, 2, 120, 3, 14, 11, 14, 25, 14, 14, 3, 135, 16, 36, 0, 14, 0, 0, 0, 25, 1, 1, 1, 53, 16, 1, 3, 244, 108, 0, 0, 32, 16, 9, 17, 121, 16, 5, 0, 2, 14, 0, 0, 184, 125, 15, 0, 135, 16, 23, 0, 14, 7, 0, 0, 27, 16, 0, 120, 3, 16, 11, 16, 25, 9, 16, 116, 82, 8, 9, 0, 34, 14, 8, 1, 121, 14, 4, 0, 1, 14, 0, 0, 0, 16, 14, 0, 119, 0, 3, 0, 26, 14, 8, 1, 0, 16, 14, 0, 85, 9, 16, 0, 137, 10, 0, 0, 139, 0, 0, 0, 140, 1, 14, 0, 0, 0, 0, 0, 2, 8, 0, 0, 184, 198, 16, 0, 1, 3, 0, 0, 2, 9, 0, 0, 180, 198, 16, 0, 78, 9, 9, 0, 2, 10, 0, 0, 179, 198, 16, 0, 78, 10, 10, 0, 20, 9, 9, 10, 2, 10, 0, 0, 86, 200, 16, 0, 78, 10, 10, 0, 20, 9, 9, 10, 2, 10, 0, 0, 87, 200, 16, 0, 78, 10, 10, 0, 20, 9, 9, 10, 41, 9, 9, 24, 42, 9, 9, 24, 121, 9, 3, 0, 134, 9, 0, 0, 148, 225, 0, 0, 2, 9, 0, 0, 140, 200, 16, 0, 82, 2, 9, 0, 1, 6, 0, 0, 27, 9, 6, 40, 3, 9, 8, 9, 25, 5, 9, 36, 82, 9, 5, 0, 47, 9, 9, 2, 56, 110, 0, 0, 1, 3, 5, 0, 119, 0, 8, 0, 25, 1, 6, 1, 35, 9, 1, 10, 121, 9, 3, 0, 0, 6, 1, 0, 119, 0, 244, 255, 1, 6, 10, 0, 119, 0, 1, 0, 32, 9, 3, 5, 121, 9, 61, 0, 35, 9, 6, 9, 121, 9, 15, 0, 1, 1, 9, 0, 27, 9, 1, 40, 3, 2, 8, 9, 26, 1, 1, 1, 27, 9, 1, 40, 3, 3, 8, 9, 25, 4, 2, 40, 116, 2, 3, 0, 25, 2, 2, 4, 25, 3, 3, 4, 54, 9, 2, 4, 128, 110, 0, 0, 54, 9, 6, 1, 104, 110, 0, 0, 2, 9, 0, 0, 180, 198, 16, 0, 78, 9, 9, 0, 2, 10, 0, 0, 179, 198, 16, 0, 78, 10, 10, 0, 20, 9, 9, 10, 2, 10, 0, 0, 86, 200, 16, 0, 78, 10, 10, 0, 20, 9, 9, 10, 41, 9, 9, 24, 42, 9, 9, 24, 120, 9, 12, 0, 2, 9, 0, 0, 87, 200, 16, 0, 78, 9, 9, 0, 32, 9, 9, 0, 2, 10, 0, 0, 194, 200, 16, 0, 2, 11, 0, 0, 188, 118, 15, 0, 125, 1, 9, 10, 11, 0, 0, 0, 119, 0, 3, 0, 2, 1, 0, 0, 188, 118, 15, 0, 27, 11, 6, 40, 3, 4, 8, 11, 135, 11, 81, 0, 4, 1, 0, 0, 107, 4, 24, 0, 2, 10, 0, 0, 84, 4, 16, 0, 82, 10, 10, 0, 109, 4, 28, 10, 2, 11, 0, 0, 132, 200, 16, 0, 82, 11, 11, 0, 109, 4, 32, 11, 2, 11, 0, 0, 140, 200, 16, 0, 82, 11, 11, 0, 85, 5, 11, 0, 2, 11, 0, 0, 180, 198, 16, 0, 78, 11, 11, 0, 2, 10, 0, 0, 179, 198, 16, 0, 78, 10, 10, 0, 20, 11, 11, 10, 2, 10, 0, 0, 86, 200, 16, 0, 78, 10, 10, 0, 20, 11, 11, 10, 2, 10, 0, 0, 87, 200, 16, 0, 78, 10, 10, 0, 20, 11, 11, 10, 41, 11, 11, 24, 42, 11, 11, 24, 120, 11, 3, 0, 134, 11, 0, 0, 148, 225, 0, 0, 2, 11, 0, 0, 168, 198, 16, 0, 1, 10, 0, 0, 85, 11, 10, 0, 1, 11, 23, 0, 1, 9, 0, 0, 2, 12, 0, 0, 196, 118, 15, 0, 135, 10, 50, 0, 11, 9, 12, 0, 134, 10, 0, 0, 4, 229, 0, 0, 33, 10, 10, 13, 121, 10, 8, 0, 1, 12, 2, 0, 135, 10, 2, 0, 12, 0, 0, 0, 134, 10, 0, 0, 4, 229, 0, 0, 33, 10, 10, 13, 120, 10, 250, 255, 1, 12, 0, 0, 135, 10, 49, 0, 12, 0, 0, 0, 1, 12, 15, 0, 135, 10, 11, 0, 12, 0, 0, 0, 1, 12, 0, 0, 1, 9, 0, 0, 2, 11, 0, 0, 226, 118, 15, 0, 135, 10, 50, 0, 12, 9, 11, 0, 1, 11, 14, 0, 135, 10, 11, 0, 11, 0, 0, 0, 1, 11, 2, 0, 1, 9, 0, 0, 2, 12, 0, 0, 254, 118, 15, 0, 135, 10, 50, 0, 11, 9, 12, 0, 1, 3, 0, 0, 1, 10, 0, 0, 27, 12, 3, 40, 3, 12, 8, 12, 106, 12, 12, 36, 47, 10, 10, 12, 52, 113, 0, 0, 135, 10, 82, 0, 3, 0, 0, 0, 27, 12, 3, 40, 3, 12, 8, 12, 135, 10, 83, 0, 12, 0, 0, 0, 25, 4, 10, 6, 25, 12, 3, 4, 1, 9, 0, 0, 135, 10, 52, 0, 12, 9, 0, 0, 13, 5, 3, 6, 1, 1, 0, 0, 2, 2, 0, 0, 0, 177, 16, 0, 1, 10, 6, 0, 16, 10, 10, 1, 17, 9, 1, 4, 19, 10, 10, 9, 0, 7, 10, 0, 121, 5, 7, 0, 1, 11, 15, 0, 1, 13, 14, 0, 125, 12, 7, 11, 13, 0, 0, 0, 0, 9, 12, 0, 119, 0, 6, 0, 1, 13, 4, 0, 1, 11, 6, 0, 125, 12, 7, 13, 11, 0, 0, 0, 0, 9, 12, 0, 135, 10, 11, 0, 9, 0, 0, 0, 78, 7, 2, 0, 41, 10, 7, 24, 42, 10, 10, 24, 32, 0, 10, 0, 1, 12, 32, 0, 125, 9, 0, 12, 7, 0, 0, 0, 135, 10, 58, 0, 9, 0, 0, 0, 25, 1, 1, 1, 32, 10, 1, 80, 120, 10, 8, 0, 121, 0, 3, 0, 0, 10, 2, 0, 119, 0, 3, 0, 25, 9, 2, 1, 0, 10, 9, 0, 0, 2, 10, 0, 119, 0, 219, 255, 25, 3, 3, 1, 33, 10, 3, 10, 120, 10, 195, 255, 1, 9, 7, 0, 135, 10, 11, 0, 9, 0, 0, 0, 1, 9, 23, 0, 1, 12, 0, 0, 2, 11, 0, 0, 3, 119, 15, 0, 135, 10, 50, 0, 9, 12, 11, 0, 134, 10, 0, 0, 4, 229, 0, 0, 33, 10, 10, 13, 121, 10, 8, 0, 1, 11, 2, 0, 135, 10, 2, 0, 11, 0, 0, 0, 134, 10, 0, 0, 4, 229, 0, 0, 33, 10, 10, 13, 120, 10, 250, 255, 139, 0, 0, 0, 140, 0, 14, 0, 0, 0, 0, 0, 2, 7, 0, 0, 131, 132, 15, 0, 2, 8, 0, 0, 162, 132, 15, 0, 2, 9, 0, 0, 192, 3, 16, 0, 136, 10, 0, 0, 0, 6, 10, 0, 136, 10, 0, 0, 25, 10, 10, 32, 137, 10, 0, 0, 25, 4, 6, 24, 25, 3, 6, 16, 25, 1, 6, 8, 0, 0, 6, 0, 2, 10, 0, 0, 57, 132, 15, 0, 1, 11, 13, 0, 134, 5, 0, 0, 60, 213, 0, 0, 10, 11, 0, 0, 121, 5, 133, 0, 27, 11, 5, 120, 3, 11, 9, 11, 102, 11, 11, 77, 33, 11, 11, 13, 121, 11, 6, 0, 2, 10, 0, 0, 62, 132, 15, 0, 135, 11, 23, 0, 10, 0, 0, 0, 119, 0, 123, 0, 2, 10, 0, 0, 94, 132, 15, 0, 135, 11, 23, 0, 10, 1, 0, 0, 2, 11, 0, 0, 98, 200, 16, 0, 79, 11, 11, 0, 45, 11, 5, 11, 80, 114, 0, 0, 2, 11, 0, 0, 98, 200, 16, 0, 1, 10, 0, 0, 83, 11, 10, 0, 27, 10, 5, 120, 3, 10, 9, 10, 25, 2, 10, 79, 78, 10, 2, 0, 1, 11, 0, 0, 1, 12, 15, 0, 138, 10, 11, 12, 180, 114, 0, 0, 188, 114, 0, 0, 196, 114, 0, 0, 204, 114, 0, 0, 212, 114, 0, 0, 220, 114, 0, 0, 232, 114, 0, 0, 240, 114, 0, 0, 248, 114, 0, 0, 0, 115, 0, 0, 8, 115, 0, 0, 16, 115, 0, 0, 24, 115, 0, 0, 32, 115, 0, 0, 44, 115, 0, 0, 135, 11, 23, 0, 8, 4, 0, 0, 119, 0, 85, 0, 135, 11, 84, 0, 119, 0, 31, 0, 135, 11, 85, 0, 119, 0, 29, 0, 135, 11, 86, 0, 119, 0, 27, 0, 135, 11, 87, 0, 119, 0, 25, 0, 135, 11, 88, 0, 119, 0, 23, 0, 134, 11, 0, 0, 168, 228, 0, 0, 119, 0, 20, 0, 135, 11, 89, 0, 119, 0, 18, 0, 135, 11, 90, 0, 119, 0, 16, 0, 135, 11, 91, 0, 119, 0, 14, 0, 135, 11, 92, 0, 119, 0, 12, 0, 135, 11, 93, 0, 119, 0, 10, 0, 135, 11, 94, 0, 119, 0, 8, 0, 135, 11, 95, 0, 119, 0, 6, 0, 135, 11, 23, 0, 7, 3, 0, 0, 119, 0, 3, 0, 135, 11, 96, 0, 119, 0, 1, 0, 1, 11, 1, 0, 135, 10, 13, 0, 11, 0, 0, 0, 27, 10, 5, 120, 3, 10, 9, 10, 25, 0, 10, 100, 82, 1, 0, 0, 1, 10, 1, 0, 47, 10, 10, 1, 148, 115, 0, 0, 26, 10, 1, 1, 85, 0, 10, 0, 79, 5, 2, 0, 2, 11, 0, 0, 246, 203, 16, 0, 90, 11, 11, 5, 2, 12, 0, 0, 71, 205, 16, 0, 27, 13, 5, 21, 3, 12, 12, 13, 134, 10, 0, 0, 52, 228, 0, 0, 11, 12, 0, 0, 119, 0, 29, 0, 2, 10, 0, 0, 152, 200, 16, 0, 2, 12, 0, 0, 152, 200, 16, 0, 82, 12, 12, 0, 26, 12, 12, 1, 85, 10, 12, 0, 1, 12, 255, 0, 19, 12, 5, 12, 0, 5, 12, 0, 2, 10, 0, 0, 64, 4, 16, 0, 135, 12, 5, 0, 10, 5, 0, 0, 79, 4, 2, 0, 2, 10, 0, 0, 246, 203, 16, 0, 90, 10, 10, 4, 2, 11, 0, 0, 71, 205, 16, 0, 27, 13, 4, 21, 3, 11, 11, 13, 134, 12, 0, 0, 52, 228, 0, 0, 10, 11, 0, 0, 135, 12, 29, 0, 5, 0, 0, 0, 119, 0, 1, 0, 137, 6, 0, 0, 139, 0, 0, 0, 140, 0, 20, 0, 0, 0, 0, 0, 2, 10, 0, 0, 176, 250, 14, 0, 2, 11, 0, 0, 192, 246, 14, 0, 2, 12, 0, 0, 173, 198, 16, 0, 2, 13, 0, 0, 76, 200, 16, 0, 1, 14, 0, 0, 83, 13, 14, 0, 135, 14, 59, 0, 135, 14, 97, 0, 1, 2, 0, 0, 2, 14, 0, 0, 96, 246, 14, 0, 41, 13, 2, 2, 94, 4, 14, 13, 78, 0, 4, 0, 41, 14, 0, 24, 42, 14, 14, 24, 121, 14, 40, 0, 1, 3, 0, 0, 1, 14, 255, 0, 19, 14, 0, 14, 0, 0, 14, 0, 2, 14, 0, 0, 96, 100, 16, 0, 91, 1, 14, 0, 78, 14, 12, 0, 121, 14, 3, 0, 135, 0, 98, 0, 0, 0, 0, 0, 2, 13, 0, 0, 174, 198, 16, 0, 78, 13, 13, 0, 32, 13, 13, 0, 121, 13, 3, 0, 0, 14, 1, 0, 119, 0, 9, 0, 1, 15, 240, 0, 19, 15, 1, 15, 32, 15, 15, 0, 1, 16, 7, 0, 1, 17, 112, 0, 125, 13, 15, 16, 17, 0, 0, 0, 0, 14, 13, 0, 0, 6, 14, 0, 32, 17, 6, 0, 1, 16, 7, 0, 125, 13, 17, 16, 6, 0, 0, 0, 135, 14, 99, 0, 0, 13, 3, 2, 25, 3, 3, 1, 90, 0, 4, 3, 41, 14, 0, 24, 42, 14, 14, 24, 33, 14, 14, 0, 120, 14, 219, 255, 25, 2, 2, 1, 33, 14, 2, 24, 120, 14, 207, 255, 1, 5, 0, 0, 27, 14, 5, 36, 3, 4, 11, 14, 0, 6, 4, 0, 25, 4, 4, 8, 82, 0, 4, 0, 120, 0, 47, 0, 27, 14, 5, 36, 3, 14, 11, 14, 25, 1, 14, 4, 1, 0, 0, 0, 27, 14, 5, 36, 3, 14, 11, 14, 25, 14, 14, 12, 41, 13, 0, 2, 94, 4, 14, 13, 27, 14, 4, 3, 3, 3, 10, 14, 79, 13, 3, 0, 103, 16, 3, 1, 103, 17, 3, 2, 82, 15, 6, 0, 3, 15, 15, 0, 82, 18, 1, 0, 135, 14, 100, 0, 4, 13, 16, 17, 15, 18, 0, 0, 32, 14, 4, 34, 121, 14, 21, 0, 1, 18, 88, 0, 1, 15, 107, 0, 1, 17, 107, 0, 1, 16, 107, 0, 82, 13, 6, 0, 3, 13, 13, 0, 82, 19, 1, 0, 135, 14, 100, 0, 18, 15, 17, 16, 13, 19, 0, 0, 1, 19, 93, 0, 1, 13, 107, 0, 1, 16, 107, 0, 1, 17, 107, 0, 82, 15, 6, 0, 3, 15, 15, 0, 82, 18, 1, 0, 135, 14, 100, 0, 19, 13, 16, 17, 15, 18, 0, 0, 25, 0, 0, 1, 33, 14, 0, 5, 120, 14, 216, 255, 119, 0, 39, 0, 1, 14, 0, 0, 47, 14, 14, 0, 124, 118, 0, 0, 27, 14, 5, 36, 3, 3, 11, 14, 25, 1, 3, 32, 25, 2, 3, 12, 25, 3, 3, 4, 1, 0, 0, 0, 82, 7, 1, 0, 33, 9, 7, 0, 1, 18, 0, 0, 125, 14, 9, 18, 0, 0, 0, 0, 82, 18, 2, 0, 3, 8, 14, 18, 121, 9, 5, 0, 27, 14, 0, 3, 3, 14, 7, 14, 0, 18, 14, 0, 119, 0, 4, 0, 27, 14, 8, 3, 3, 14, 10, 14, 0, 18, 14, 0, 0, 7, 18, 0, 79, 14, 7, 0, 103, 15, 7, 1, 103, 17, 7, 2, 82, 16, 6, 0, 3, 16, 16, 0, 82, 13, 3, 0, 135, 18, 100, 0, 8, 14, 15, 17, 16, 13, 0, 0, 25, 0, 0, 1, 82, 18, 4, 0, 54, 18, 0, 18, 8, 118, 0, 0, 25, 5, 5, 1, 33, 18, 5, 18, 120, 18, 164, 255, 135, 18, 101, 0, 1, 18, 20, 0, 134, 9, 0, 0, 16, 165, 0, 0, 18, 0, 0, 0, 1, 13, 0, 2, 13, 13, 9, 13, 1, 16, 0, 0, 125, 18, 13, 16, 9, 0, 0, 0, 1, 16, 0, 0, 1, 13, 33, 0, 138, 18, 16, 13, 80, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 84, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 88, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 64, 119, 0, 0, 92, 119, 0, 0, 1, 13, 2, 0, 135, 16, 2, 0, 13, 0, 0, 0, 119, 0, 208, 255, 119, 0, 207, 255, 119, 0, 3, 0, 119, 0, 2, 0, 119, 0, 1, 0, 139, 0, 0, 0, 140, 3, 19, 0, 0, 0, 0, 0, 2, 13, 0, 0, 152, 0, 0, 0, 2, 14, 0, 0, 150, 0, 0, 0, 2, 15, 0, 0, 147, 0, 0, 0, 1, 11, 0, 0, 136, 16, 0, 0, 0, 12, 16, 0, 136, 16, 0, 0, 25, 16, 16, 16, 137, 16, 0, 0, 25, 9, 12, 4, 0, 10, 12, 0, 2, 16, 0, 0, 188, 221, 16, 0, 82, 16, 16, 0, 121, 16, 5, 0, 1, 17, 1, 0, 134, 16, 0, 0, 8, 135, 0, 0, 17, 0, 0, 0, 1, 17, 0, 0, 1, 18, 0, 0, 135, 16, 52, 0, 17, 18, 0, 0, 135, 16, 102, 0, 1, 18, 7, 0, 135, 16, 11, 0, 18, 0, 0, 0, 135, 16, 103, 0, 0, 0, 0, 0, 0, 8, 1, 0, 0, 0, 1, 0, 1, 7, 32, 0, 13, 6, 0, 1, 4, 16, 0, 8], eb + 20480);
    HEAPU8.set([15, 4, 16, 2, 1, 18, 112, 0, 135, 16, 11, 0, 18, 0, 0, 0, 135, 16, 104, 0, 7, 0, 0, 0, 1, 18, 7, 0, 135, 16, 11, 0, 18, 0, 0, 0, 134, 3, 0, 0, 4, 229, 0, 0, 1, 16, 8, 0, 1, 18, 145, 0, 138, 3, 16, 18, 128, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 132, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 140, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 152, 122, 0, 0, 124, 122, 0, 0, 160, 122, 0, 0, 124, 122, 0, 0, 124, 122, 0, 0, 16, 123, 0, 0, 119, 0, 39, 0, 119, 0, 8, 0, 1, 11, 14, 0, 119, 0, 107, 0, 0, 0, 1, 0, 1, 3, 27, 0, 119, 0, 104, 0, 1, 11, 7, 0, 119, 0, 77, 0, 120, 6, 3, 0, 1, 11, 11, 0, 119, 0, 42, 0, 1, 16, 13, 0, 1, 18, 15, 0, 138, 3, 16, 18, 248, 122, 0, 0, 244, 122, 0, 0, 244, 122, 0, 0, 244, 122, 0, 0, 244, 122, 0, 0, 244, 122, 0, 0, 244, 122, 0, 0, 244, 122, 0, 0, 244, 122, 0, 0, 244, 122, 0, 0, 244, 122, 0, 0, 244, 122, 0, 0, 244, 122, 0, 0, 244, 122, 0, 0, 4, 123, 0, 0, 119, 0, 9, 0, 0, 0, 1, 0, 1, 11, 14, 0, 119, 0, 77, 0, 0, 0, 1, 0, 1, 3, 27, 0, 119, 0, 74, 0, 1, 11, 9, 0, 119, 0, 47, 0, 13, 5, 3, 14, 26, 16, 3, 32, 35, 16, 16, 95, 20, 16, 5, 16, 40, 16, 16, 1, 40, 18, 4, 1, 20, 16, 16, 18, 120, 16, 3, 0, 1, 11, 17, 0, 119, 0, 5, 0, 1, 18, 2, 0, 135, 16, 2, 0, 18, 0, 0, 0, 119, 0, 46, 255, 32, 16, 11, 11, 121, 16, 14, 0, 1, 11, 0, 0, 1, 18, 32, 0, 135, 16, 104, 0, 18, 0, 0, 0, 135, 16, 105, 0, 10, 9, 0, 0, 82, 18, 10, 0, 82, 17, 9, 0, 26, 17, 17, 1, 135, 16, 52, 0, 18, 17, 0, 0, 26, 0, 0, 1, 119, 0, 28, 255, 32, 16, 11, 17, 121, 16, 26, 255, 1, 11, 0, 0, 125, 6, 5, 7, 3, 0, 0, 0, 83, 0, 6, 0, 135, 16, 104, 0, 6, 0, 0, 0, 135, 16, 105, 0, 10, 9, 0, 0, 82, 17, 10, 0, 82, 18, 9, 0, 25, 18, 18, 1, 135, 16, 52, 0, 17, 18, 0, 0, 25, 0, 0, 1, 119, 0, 11, 255, 32, 16, 11, 7, 121, 16, 11, 0, 1, 11, 0, 0, 32, 18, 7, 32, 121, 18, 4, 0, 1, 18, 126, 0, 0, 16, 18, 0, 119, 0, 3, 0, 26, 18, 7, 1, 0, 16, 18, 0, 0, 3, 16, 0, 119, 0, 12, 0, 32, 16, 11, 9, 121, 16, 10, 0, 1, 11, 0, 0, 32, 18, 7, 126, 121, 18, 4, 0, 1, 18, 32, 0, 0, 16, 18, 0, 119, 0, 3, 0, 25, 18, 7, 1, 0, 16, 18, 0, 0, 3, 16, 0, 0, 7, 3, 0, 119, 0, 242, 254, 1, 16, 0, 0, 83, 0, 16, 0, 135, 16, 18, 0, 137, 12, 0, 0, 139, 3, 0, 0, 140, 0, 13, 0, 0, 0, 0, 0, 2, 6, 0, 0, 62, 135, 15, 0, 2, 7, 0, 0, 97, 135, 15, 0, 2, 8, 0, 0, 192, 3, 16, 0, 136, 9, 0, 0, 0, 5, 9, 0, 136, 9, 0, 0, 25, 9, 9, 32, 137, 9, 0, 0, 25, 2, 5, 16, 25, 1, 5, 8, 0, 0, 5, 0, 2, 9, 0, 0, 17, 135, 15, 0, 1, 10, 173, 0, 134, 4, 0, 0, 60, 213, 0, 0, 9, 10, 0, 0, 121, 4, 125, 0, 27, 10, 4, 120, 3, 10, 8, 10, 102, 10, 10, 77, 33, 10, 10, 173, 121, 10, 6, 0, 2, 9, 0, 0, 23, 135, 15, 0, 135, 10, 23, 0, 9, 0, 0, 0, 119, 0, 115, 0, 1, 9, 6, 0, 135, 10, 2, 0, 9, 0, 0, 0, 2, 10, 0, 0, 98, 200, 16, 0, 79, 10, 10, 0, 45, 10, 4, 10, 252, 124, 0, 0, 2, 10, 0, 0, 98, 200, 16, 0, 1, 9, 0, 0, 83, 10, 9, 0, 27, 9, 4, 120, 3, 9, 8, 9, 25, 3, 9, 79, 78, 9, 3, 0, 1, 10, 0, 0, 1, 11, 14, 0, 138, 9, 10, 11, 92, 125, 0, 0, 100, 125, 0, 0, 108, 125, 0, 0, 116, 125, 0, 0, 124, 125, 0, 0, 132, 125, 0, 0, 140, 125, 0, 0, 148, 125, 0, 0, 156, 125, 0, 0, 164, 125, 0, 0, 172, 125, 0, 0, 180, 125, 0, 0, 188, 125, 0, 0, 196, 125, 0, 0, 135, 10, 23, 0, 7, 2, 0, 0, 119, 0, 79, 0, 135, 10, 106, 0, 119, 0, 28, 0, 135, 10, 107, 0, 119, 0, 26, 0, 135, 10, 108, 0, 119, 0, 24, 0, 135, 10, 109, 0, 119, 0, 22, 0, 135, 10, 110, 0, 119, 0, 20, 0, 135, 10, 111, 0, 119, 0, 18, 0, 135, 10, 112, 0, 119, 0, 16, 0, 135, 10, 113, 0, 119, 0, 14, 0, 135, 10, 114, 0, 119, 0, 12, 0, 135, 10, 115, 0, 119, 0, 10, 0, 135, 10, 116, 0, 119, 0, 8, 0, 135, 10, 117, 0, 119, 0, 6, 0, 135, 10, 118, 0, 119, 0, 4, 0, 135, 10, 23, 0, 6, 1, 0, 0, 119, 0, 1, 0, 27, 9, 4, 120, 3, 9, 8, 9, 25, 0, 9, 100, 82, 1, 0, 0, 1, 9, 1, 0, 47, 9, 9, 1, 36, 126, 0, 0, 26, 9, 1, 1, 85, 0, 9, 0, 79, 4, 3, 0, 2, 10, 0, 0, 5, 204, 16, 0, 90, 10, 10, 4, 2, 11, 0, 0, 130, 206, 16, 0, 27, 12, 4, 21, 3, 11, 11, 12, 134, 9, 0, 0, 52, 228, 0, 0, 10, 11, 0, 0, 119, 0, 29, 0, 2, 9, 0, 0, 152, 200, 16, 0, 2, 11, 0, 0, 152, 200, 16, 0, 82, 11, 11, 0, 26, 11, 11, 1, 85, 9, 11, 0, 1, 11, 255, 0, 19, 11, 4, 11, 0, 4, 11, 0, 2, 9, 0, 0, 64, 4, 16, 0, 135, 11, 5, 0, 9, 4, 0, 0, 79, 3, 3, 0, 2, 9, 0, 0, 5, 204, 16, 0, 90, 9, 9, 3, 2, 10, 0, 0, 130, 206, 16, 0, 27, 12, 3, 21, 3, 10, 10, 12, 134, 11, 0, 0, 52, 228, 0, 0, 9, 10, 0, 0, 135, 11, 29, 0, 4, 0, 0, 0, 119, 0, 1, 0, 137, 5, 0, 0, 139, 0, 0, 0, 140, 2, 20, 0, 0, 0, 0, 0, 2, 12, 0, 0, 255, 0, 0, 0, 2, 13, 0, 0, 192, 3, 16, 0, 2, 14, 0, 0, 23, 138, 15, 0, 1, 10, 0, 0, 136, 15, 0, 0, 0, 11, 15, 0, 136, 15, 0, 0, 25, 15, 15, 16, 137, 15, 0, 0, 25, 9, 11, 8, 0, 8, 11, 0, 135, 15, 55, 0, 32, 7, 1, 0, 2, 15, 0, 0, 64, 4, 16, 0, 78, 4, 15, 0, 41, 15, 4, 24, 42, 15, 15, 24, 120, 15, 3, 0, 1, 10, 21, 0, 119, 0, 1, 1, 1, 3, 0, 0, 1, 2, 32, 0, 1, 5, 0, 0, 19, 15, 4, 12, 0, 6, 15, 0, 135, 15, 119, 0, 6, 0, 0, 0, 120, 15, 33, 0, 120, 5, 4, 0, 1, 16, 0, 0, 135, 15, 49, 0, 16, 0, 0, 0, 13, 4, 5, 3, 121, 4, 3, 0, 135, 2, 53, 0, 6, 0, 0, 0, 1, 17, 112, 0, 1, 18, 7, 0, 125, 16, 4, 17, 18, 0, 0, 0, 135, 15, 11, 0, 16, 0, 0, 0, 1, 16, 0, 0, 135, 18, 53, 0, 6, 0, 0, 0, 19, 18, 18, 12, 135, 15, 8, 0, 5, 16, 18, 0, 1, 18, 1, 0, 135, 15, 50, 0, 5, 18, 14, 0, 1, 18, 0, 0, 135, 15, 28, 0, 6, 18, 0, 0, 1, 18, 3, 0, 2, 16, 0, 0, 242, 200, 16, 0, 135, 15, 50, 0, 5, 18, 16, 0, 25, 5, 5, 1, 27, 15, 6, 120, 3, 15, 13, 15, 102, 4, 15, 1, 41, 15, 4, 24, 42, 15, 15, 24, 120, 15, 2, 0, 119, 0, 4, 0, 19, 15, 4, 12, 0, 6, 15, 0, 119, 0, 212, 255, 120, 5, 3, 0, 1, 10, 21, 0, 119, 0, 204, 0, 1, 16, 7, 0, 135, 15, 11, 0, 16, 0, 0, 0, 1, 16, 23, 0, 1, 18, 0, 0, 135, 15, 52, 0, 16, 18, 0, 0, 121, 7, 3, 0, 1, 10, 15, 0, 119, 0, 10, 0, 78, 15, 1, 0, 120, 15, 3, 0, 1, 10, 15, 0, 119, 0, 6, 0, 85, 8, 1, 0, 2, 18, 0, 0, 26, 138, 15, 0, 135, 15, 54, 0, 18, 8, 0, 0, 32, 15, 10, 15, 121, 15, 6, 0, 1, 10, 0, 0, 2, 18, 0, 0, 96, 113, 15, 0, 135, 15, 103, 0, 18, 0, 0, 0, 134, 4, 0, 0, 4, 229, 0, 0, 1, 15, 13, 0, 1, 18, 140, 0, 138, 4, 15, 18, 172, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 180, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 184, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 192, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 132, 130, 0, 0, 208, 130, 0, 0, 135, 15, 120, 0, 4, 0, 0, 0, 121, 15, 4, 0, 0, 2, 4, 0, 1, 10, 23, 0, 119, 0, 26, 0, 1, 18, 2, 0, 135, 15, 2, 0, 18, 0, 0, 0, 119, 0, 14, 0, 1, 10, 23, 0, 119, 0, 20, 0, 119, 0, 1, 0, 0, 2, 4, 0, 119, 0, 17, 0, 3, 15, 5, 3, 26, 15, 15, 1, 8, 3, 15, 5, 119, 0, 5, 0, 3, 15, 5, 3, 25, 15, 15, 1, 8, 3, 15, 5, 119, 0, 1, 0, 2, 15, 0, 0, 64, 4, 16, 0, 78, 4, 15, 0, 41, 15, 4, 24, 42, 15, 15, 24, 120, 15, 6, 255, 1, 10, 21, 0, 119, 0, 2, 0, 135, 15, 56, 0, 32, 15, 10, 21, 121, 15, 11, 0, 32, 16, 0, 0, 2, 17, 0, 0, 61, 138, 15, 0, 2, 19, 0, 0, 83, 138, 15, 0, 125, 18, 16, 17, 19, 0, 0, 0, 135, 15, 23, 0, 18, 9, 0, 0, 1, 2, 0, 0, 137, 11, 0, 0, 139, 2, 0, 0, 140, 0, 15, 0, 0, 0, 0, 0, 2, 8, 0, 0, 192, 3, 16, 0, 2, 9, 0, 0, 255, 0, 0, 0, 2, 10, 0, 0, 215, 137, 15, 0, 1, 6, 0, 0, 136, 11, 0, 0, 0, 7, 11, 0, 136, 11, 0, 0, 25, 11, 11, 32, 137, 11, 0, 0, 25, 5, 7, 16, 25, 4, 7, 8, 0, 0, 7, 0, 2, 11, 0, 0, 128, 61, 16, 0, 2, 12, 0, 0, 60, 4, 16, 0, 78, 12, 12, 0, 26, 12, 12, 1, 2, 13, 0, 0, 59, 4, 16, 0, 78, 13, 13, 0, 27, 13, 13, 22, 3, 12, 12, 13, 90, 11, 11, 12, 1, 12, 177, 255, 1, 13, 74, 0, 138, 11, 12, 13, 248, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 228, 132, 0, 0, 252, 132, 0, 0, 2, 13, 0, 0, 176, 137, 15, 0, 135, 12, 23, 0, 13, 0, 0, 0, 119, 0, 131, 0, 119, 0, 1, 0, 2, 12, 0, 0, 210, 137, 15, 0, 1, 13, 0, 0, 134, 3, 0, 0, 60, 213, 0, 0, 12, 13, 0, 0, 121, 3, 123, 0, 134, 2, 0, 0, 24, 175, 0, 0, 3, 0, 0, 0, 32, 13, 2, 0, 2, 12, 0, 0, 74, 200, 16, 0, 78, 12, 12, 0, 33, 12, 12, 0, 20, 13, 13, 12, 120, 13, 113, 0, 27, 13, 3, 120, 3, 13, 8, 13, 25, 2, 13, 100, 1, 13, 1, 0, 82, 12, 2, 0, 47, 13, 13, 12, 228, 133, 0, 0, 27, 13, 3, 120, 3, 13, 8, 13, 102, 13, 13, 77, 32, 13, 13, 24, 121, 13, 3, 0, 1, 6, 10, 0, 119, 0, 29, 0, 135, 0, 37, 0, 19, 13, 0, 9, 0, 1, 13, 0, 41, 13, 0, 24, 42, 13, 13, 24, 120, 13, 4, 0, 135, 13, 23, 0, 10, 4, 0, 0, 119, 0, 90, 0, 82, 13, 2, 0, 26, 13, 13, 1, 85, 2, 13, 0, 27, 13, 1, 120, 3, 4, 8, 13, 27, 13, 3, 120, 3, 2, 8, 13, 25, 3, 4, 120, 116, 4, 2, 0, 25, 4, 4, 4, 25, 2, 2, 4, 54, 13, 4, 3, 188, 133, 0, 0, 27, 13, 1, 120, 3, 13, 8, 13, 1, 12, 1, 0, 109, 13, 100, 12, 119, 0, 2, 0, 1, 6, 10, 0, 32, 12, 6, 10, 121, 12, 15, 0, 2, 12, 0, 0, 152, 200, 16, 0, 2, 13, 0, 0, 152, 200, 16, 0, 82, 13, 13, 0, 26, 13, 13, 1, 85, 12, 13, 0, 19, 13, 3, 9, 0, 0, 13, 0, 2, 12, 0, 0, 64, 4, 16, 0, 135, 13, 5, 0, 12, 0, 0, 0, 0, 1, 3, 0, 2, 12, 0, 0, 72, 200, 16, 0, 135, 13, 6, 0, 12, 0, 0, 0, 27, 13, 1, 120, 3, 4, 8, 13, 102, 6, 4, 77, 2, 13, 0, 0, 128, 61, 16, 0, 2, 12, 0, 0, 60, 4, 16, 0, 78, 12, 12, 0, 26, 12, 12, 1, 2, 14, 0, 0, 59, 4, 16, 0, 78, 14, 14, 0, 27, 14, 14, 22, 3, 12, 12, 14, 95, 13, 12, 6, 25, 4, 4, 3, 2, 12, 0, 0, 59, 4, 16, 0, 79, 12, 12, 0, 2, 13, 0, 0, 60, 4, 16, 0, 79, 13, 13, 0, 41, 13, 13, 8, 20, 12, 12, 13, 0, 3, 12, 0, 83, 4, 3, 0, 42, 13, 3, 8, 107, 4, 1, 13, 41, 13, 6, 24, 42, 13, 13, 24, 32, 13, 13, 12, 121, 13, 5, 0, 2, 13, 0, 0, 89, 200, 16, 0, 1, 12, 0, 0, 83, 13, 12, 0, 1, 13, 5, 0, 135, 12, 2, 0, 13, 0, 0, 0, 1, 13, 1, 0, 135, 12, 28, 0, 1, 13, 0, 0, 2, 12, 0, 0, 242, 200, 16, 0, 85, 5, 12, 0, 2, 13, 0, 0, 11, 138, 15, 0, 135, 12, 23, 0, 13, 5, 0, 0, 119, 0, 1, 0, 137, 7, 0, 0, 139, 0, 0, 0, 140, 1, 11, 0, 0, 0, 0, 0, 2, 5, 0, 0, 96, 101, 16, 0, 2, 6, 0, 0, 111, 55, 4, 0, 1, 3, 0, 0, 2, 7, 0, 0, 188, 221, 16, 0, 82, 1, 7, 0, 121, 1, 145, 0, 34, 7, 1, 81, 121, 7, 26, 0, 32, 2, 0, 0, 120, 2, 2, 0, 135, 7, 55, 0, 1, 0, 0, 0, 2, 7, 0, 0, 188, 221, 16, 0, 82, 7, 7, 0, 47, 7, 0, 7, 104, 135, 0, 0, 90, 1, 5, 0, 119, 0, 2, 0, 1, 1, 32, 0, 41, 8, 1, 24, 42, 8, 8, 24, 1, 9, 7, 0, 1, 10, 0, 0, 135, 7, 121, 0, 8, 9, 0, 10, 25, 0, 0, 1, 33, 7, 0, 80, 120, 7, 240, 255, 120, 2, 72, 0, 1, 1, 1, 0, 1, 3, 23, 0, 119, 0, 69, 0, 135, 7, 55, 0, 2, 7, 0, 0, 188, 221, 16, 0, 82, 0, 7, 0, 1, 7, 0, 0, 47, 7, 7, 0, 168, 136, 0, 0, 1, 3, 0, 0, 1, 1, 0, 0, 0, 4, 3, 0, 90, 7, 5, 4, 32, 7, 7, 32, 121, 7, 3, 0, 25, 4, 4, 1, 119, 0, 252, 255, 25, 2, 4, 80, 15, 7, 0, 2, 125, 3, 7, 0, 2, 0, 0, 0, 17, 7, 3, 4, 17, 10, 0, 2, 20, 7, 7, 10, 121, 7, 3, 0, 0, 0, 3, 0, 119, 0, 14, 0, 0, 2, 3, 0, 90, 7, 5, 2, 32, 7, 7, 32, 121, 7, 3, 0, 0, 0, 2, 0, 119, 0, 8, 0, 26, 2, 2, 1, 17, 7, 2, 4, 13, 10, 2, 0, 20, 7, 7, 10, 121, 7, 247, 255, 0, 0, 2, 0, 119, 0, 1, 0, 13, 7, 0, 4, 125, 3, 7, 3, 0, 0, 0, 0, 1, 2, 0, 0, 3, 0, 2, 4, 47, 7, 0, 3, 92, 136, 0, 0, 90, 0, 5, 0, 119, 0, 2, 0, 1, 0, 32, 0, 41, 10, 0, 24, 42, 10, 10, 24, 1, 9, 7, 0, 135, 7, 121, 0, 10, 9, 2, 1, 25, 2, 2, 1, 33, 7, 2, 80, 120, 7, 243, 255, 25, 1, 1, 1, 2, 7, 0, 0, 188, 221, 16, 0, 82, 0, 7, 0, 35, 7, 1, 20, 15, 9, 3, 0, 19, 7, 7, 9, 120, 7, 202, 255, 1, 3, 23, 0, 119, 0, 3, 0, 1, 1, 0, 0, 1, 3, 23, 0, 32, 7, 3, 23, 121, 7, 44, 0, 1, 0, 0, 0, 2, 9, 0, 0, 96, 113, 15, 0, 90, 9, 9, 0, 1, 10, 15, 0, 135, 7, 121, 0, 9, 10, 0, 1, 25, 0, 0, 1, 33, 7, 0, 25, 120, 7, 248, 255, 134, 7, 0, 0, 4, 229, 0, 0, 1, 10, 13, 0, 1, 9, 20, 0, 138, 7, 10, 9, 72, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 68, 137, 0, 0, 76, 137, 0, 0, 119, 0, 3, 0, 119, 0, 6, 0, 119, 0, 5, 0, 1, 10, 2, 0, 135, 7, 2, 0, 10, 0, 0, 0, 119, 0, 225, 255, 135, 7, 56, 0, 2, 7, 0, 0, 188, 221, 16, 0, 1, 10, 0, 0, 85, 7, 10, 0, 139, 0, 0, 0, 140, 1, 14, 0, 0, 0, 0, 0, 136, 9, 0, 0, 0, 8, 9, 0, 136, 9, 0, 0, 25, 9, 9, 96, 137, 9, 0, 0, 25, 4, 8, 88, 25, 3, 8, 80, 0, 1, 8, 0, 25, 2, 8, 92, 2, 9, 0, 0, 168, 198, 16, 0, 1, 10, 2, 0, 85, 9, 10, 0, 135, 10, 122, 0, 2, 0, 0, 0, 135, 10, 123, 0, 2, 0, 0, 0, 25, 2, 10, 20, 82, 10, 2, 0, 1, 9, 108, 7, 3, 2, 10, 9, 2, 9, 0, 0, 140, 200, 16, 0, 82, 7, 9, 0, 2, 9, 0, 0, 140, 200, 16, 0, 28, 10, 7, 10, 4, 10, 7, 10, 85, 9, 10, 0, 1, 9, 1, 0, 135, 10, 124, 0, 0, 9, 0, 0, 2, 10, 0, 0, 181, 198, 16, 0, 78, 10, 10, 0, 120, 10, 8, 0, 1, 9, 1, 0, 2, 11, 0, 0, 174, 198, 16, 0, 79, 11, 11, 0, 134, 10, 0, 0, 244, 201, 0, 0, 9, 11, 0, 0, 1, 11, 0, 0, 135, 10, 49, 0, 11, 0, 0, 0, 1, 11, 6, 0, 135, 10, 11, 0, 11, 0, 0, 0, 1, 11, 7, 0, 1, 9, 26, 0, 1, 12, 22, 0, 1, 13, 53, 0, 135, 10, 125, 0, 11, 9, 12, 13, 1, 13, 7, 0, 135, 10, 11, 0, 13, 0, 0, 0, 1, 13, 10, 0, 2, 12, 0, 0, 91, 118, 15, 0, 135, 10, 57, 0, 13, 12, 0, 0, 1, 12, 11, 0, 2, 13, 0, 0, 96, 118, 15, 0, 135, 10, 57, 0, 12, 13, 0, 0, 1, 13, 12, 0, 2, 12, 0, 0, 99, 118, 15, 0, 135, 10, 57, 0, 13, 12, 0, 0, 1, 12, 4, 0, 135, 10, 11, 0, 12, 0, 0, 0, 1, 12, 21, 0, 2, 13, 0, 0, 105, 118, 15, 0, 135, 10, 57, 0, 12, 13, 0, 0, 1, 13, 2, 0, 135, 10, 11, 0, 13, 0, 0, 0, 1, 13, 22, 0, 2, 12, 0, 0, 122, 118, 15, 0, 135, 10, 57, 0, 13, 12, 0, 0, 1, 12, 7, 0, 135, 10, 11, 0, 12, 0, 0, 0, 1, 12, 14, 0, 2, 13, 0, 0, 194, 200, 16, 0, 135, 10, 57, 0, 12, 13, 0, 0, 0, 5, 1, 0, 2, 6, 0, 0, 160, 118, 15, 0, 25, 7, 5, 10, 78, 10, 6, 0, 83, 5, 10, 0, 25, 5, 5, 1, 25, 6, 6, 1, 54, 10, 5, 7, 20, 139, 0, 0, 1, 13, 15, 0, 135, 10, 57, 0, 13, 1, 0, 0, 1, 13, 16, 0, 2, 12, 0, 0, 242, 200, 16, 0, 135, 10, 57, 0, 13, 12, 0, 0, 2, 10, 0, 0, 140, 200, 16, 0, 82, 10, 10, 0, 85, 3, 10, 0, 2, 12, 0, 0, 170, 118, 15, 0, 135, 10, 24, 0, 1, 12, 3, 0, 1, 12, 18, 0, 135, 10, 57, 0, 12, 1, 0, 0, 85, 4, 2, 0, 2, 12, 0, 0, 111, 144, 15, 0, 135, 10, 24, 0, 1, 12, 4, 0, 1, 12, 19, 0, 135, 10, 57, 0, 12, 1, 0, 0, 2, 10, 0, 0, 181, 198, 16, 0, 78, 10, 10, 0, 120, 10, 17, 0, 135, 10, 51, 0, 1, 12, 0, 0, 2, 13, 0, 0, 174, 198, 16, 0, 79, 13, 13, 0, 134, 10, 0, 0, 244, 201, 0, 0, 12, 13, 0, 0, 2, 10, 0, 0, 181, 198, 16, 0, 78, 10, 10, 0, 120, 10, 3, 0, 1, 2, 10, 0, 119, 0, 4, 0, 1, 2, 5, 0, 119, 0, 2, 0, 1, 2, 5, 0, 32, 10, 2, 5, 121, 10, 44, 0, 1, 13, 23, 0, 1, 12, 0, 0, 2, 9, 0, 0, 176, 118, 15, 0, 135, 10, 50, 0, 13, 12, 9, 0, 134, 10, 0, 0, 4, 229, 0, 0, 39, 10, 10, 32, 1, 9, 110, 0, 1, 12, 12, 0, 138, 10, 9, 12, 88, 140, 0, 0, 84, 140, 0, 0, 84, 140, 0, 0, 84, 140, 0, 0, 84, 140, 0, 0, 84, 140, 0, 0, 84, 140, 0, 0, 84, 140, 0, 0, 84, 140, 0, 0, 84, 140, 0, 0, 84, 140, 0, 0, 96, 140, 0, 0, 119, 0, 4, 0, 1, 2, 10, 0, 119, 0, 17, 0, 119, 0, 5, 0, 1, 9, 2, 0, 135, 10, 2, 0, 9, 0, 0, 0, 119, 0, 231, 255, 1, 9, 1, 0, 135, 10, 15, 0, 9, 0, 0, 0, 120, 10, 3, 0, 1, 2, 10, 0, 119, 0, 6, 0, 2, 10, 0, 0, 168, 198, 16, 0, 1, 9, 1, 0, 85, 10, 9, 0, 1, 1, 2, 0, 32, 9, 2, 10, 121, 9, 5, 0, 134, 9, 0, 0, 164, 109, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 2, 9, 0, 0, 74, 200, 16, 0, 83, 9, 1, 0, 137, 8, 0, 0, 139, 0, 0, 0, 140, 0, 12, 0, 0, 0, 0, 0, 2, 6, 0, 0, 38, 50, 4, 0, 2, 7, 0, 0, 192, 3, 16, 0, 2, 8, 0, 0, 255, 0, 0, 0, 136, 9, 0, 0, 0, 4, 9, 0, 136, 9, 0, 0, 25, 9, 9, 16, 137, 9, 0, 0, 0, 2, 4, 0, 2, 9, 0, 0, 195, 138, 15, 0, 1, 10, 24, 0, 134, 0, 0, 0, 60, 213, 0, 0, 9, 10, 0, 0, 121, 0, 127, 0, 134, 10, 0, 0, 100, 203, 0, 0, 120, 10, 6, 0, 2, 10, 0, 0, 76, 200, 16, 0, 1, 9, 0, 0, 83, 10, 9, 0, 119, 0, 119, 0, 134, 1, 0, 0, 24, 175, 0, 0, 0, 0, 0, 0, 2, 9, 0, 0, 74, 200, 16, 0, 78, 9, 9, 0, 120, 9, 112, 0, 120, 1, 6, 0, 2, 9, 0, 0, 76, 200, 16, 0, 1, 10, 0, 0, 83, 9, 10, 0, 119, 0, 106, 0, 135, 10, 126, 0, 0, 0, 0, 0, 121, 10, 6, 0, 2, 10, 0, 0, 76, 200, 16, 0, 1, 9, 0, 0, 83, 10, 9, 0, 119, 0, 98, 0, 27, 9, 0, 120, 3, 9, 7, 9, 25, 1, 9, 100, 82, 9, 1, 0, 34, 9, 9, 2, 121, 9, 14, 0, 2, 9, 0, 0, 152, 200, 16, 0, 2, 10, 0, 0, 152, 200, 16, 0, 82, 10, 10, 0, 26, 10, 10, 1, 85, 9, 10, 0, 2, 9, 0, 0, 64, 4, 16, 0, 19, 11, 0, 8, 135, 10, 5, 0, 9, 11, 0, 0, 119, 0, 45, 0, 135, 5, 37, 0, 19, 10, 5, 8, 0, 3, 10, 0, 41, 10, 5, 24, 42, 10, 10, 24, 120, 10, 20, 0, 2, 11, 0, 0, 201, 138, 15, 0, 135, 10, 23, 0, 11, 2, 0, 0, 1, 10, 1, 0, 85, 1, 10, 0, 2, 10, 0, 0, 152, 200, 16, 0, 2, 11, 0, 0, 152, 200, 16, 0, 82, 11, 11, 0, 26, 11, 11, 1, 85, 10, 11, 0, 2, 10, 0, 0, 64, 4, 16, 0, 19, 9, 0, 8, 135, 11, 5, 0, 10, 9, 0, 0, 119, 0, 20, 0, 82, 11, 1, 0, 26, 11, 11, 1, 85, 1, 11, 0, 27, 11, 3, 120, 3, 2, 7, 11, 27, 11, 0, 120, 3, 0, 7, 11, 25, 1, 2, 120, 116, 2, 0, 0, 25, 2, 2, 4, 25, 0, 0, 4, 54, 11, 2, 1, 100, 142, 0, 0, 27, 11, 3, 120, 3, 11, 7, 11, 1, 9, 1, 0, 109, 11, 100, 9, 0, 0, 3, 0, 119, 0, 1, 0, 27, 9, 0, 120, 3, 9, 7, 9, 102, 9, 9, 77, 32, 9, 9, 12, 121, 9, 5, 0, 2, 9, 0, 0, 89, 200, 16, 0, 1, 11, 0, 0, 83, 9, 11, 0, 1, 9, 24, 0, 135, 11, 2, 0, 9, 0, 0, 0, 2, 9, 0, 0, 187, 200, 16, 0, 78, 9, 9, 0, 2, 10, 0, 0, 186, 200, 16, 0, 78, 10, 10, 0, 134, 11, 0, 0, 188, 180, 0, 0, 0, 9, 10, 0, 27, 11, 0, 120, 3, 2, 7, 11, 102, 1, 2, 4, 102, 2, 2, 3, 135, 11, 34, 0, 1, 2, 0, 0, 121, 11, 4, 0, 135, 11, 38, 0, 1, 2, 0, 0, 120, 11, 4, 0, 1, 10, 1, 0, 135, 11, 69, 0, 0, 10, 0, 0, 137, 4, 0, 0, 139, 0, 0, 0, 140, 1, 16, 0, 0, 0, 0, 0, 136, 12, 0, 0, 0, 11, 12, 0, 136, 12, 0, 0, 25, 12, 12, 16, 137, 12, 0, 0, 0, 10, 11, 0, 134, 12, 0, 0, 100, 203, 0, 0, 120, 12, 6, 0, 2, 12, 0, 0, 76, 200, 16, 0, 1, 13, 0, 0, 83, 12, 13, 0, 119, 0, 129, 0, 2, 13, 0, 0, 60, 4, 16, 0, 78, 1, 13, 0, 2, 13, 0, 0, 59, 4, 16, 0, 78, 2, 13, 0, 135, 12, 33, 0, 1, 2, 0, 0, 135, 13, 127, 0, 12, 0, 0, 0, 121, 13, 15, 0, 2, 13, 0, 0, 187, 200, 16, 0, 78, 3, 13, 0, 2, 13, 0, 0, 186, 200, 16, 0, 78, 4, 13, 0, 3, 1, 1, 3, 3, 2, 2, 4, 135, 12, 33, 0, 1, 2, 0, 0, 135, 13, 127, 0, 12, 0, 0, 0, 33, 13, 13, 0, 120, 13, 249, 255, 135, 3, 34, 0, 1, 2, 0, 0, 121, 3, 87, 0, 2, 13, 0, 0, 192, 3, 16, 0, 27, 12, 3, 120, 3, 13, 13, 12, 102, 4, 13, 14, 41, 13, 4, 24, 42, 13, 13, 24, 32, 13, 13, 70, 121, 13, 9, 0, 2, 13, 0, 0, 62, 4, 16, 0, 2, 12, 0, 0, 62, 4, 16, 0, 80, 12, 12, 0, 1, 14, 127, 255, 19, 12, 12, 14, 84, 13, 12, 0, 2, 12, 0, 0, 192, 3, 16, 0, 27, 13, 3, 120, 3, 12, 12, 13, 25, 5, 12, 8, 78, 6, 5, 0, 2, 13, 0, 0, 73, 200, 16, 0, 1, 14, 255, 0, 19, 14, 3, 14, 135, 12, 5, 0, 13, 14, 0, 0, 135, 12, 10, 0, 3, 0, 0, 0, 121, 12, 9, 0, 2, 14, 0, 0, 128, 61, 16, 0, 26, 13, 1, 1, 27, 15, 2, 22, 3, 13, 13, 15, 90, 14, 14, 13, 135, 12, 8, 0, 1, 2, 14, 0, 2, 12, 0, 0, 192, 3, 16, 0, 27, 14, 3, 120, 3, 12, 12, 14, 25, 7, 12, 11, 78, 8, 7, 0, 1, 14, 26, 0, 135, 12, 1, 0, 14, 0, 0, 0, 25, 12, 12, 65, 1, 14, 255, 0, 19, 12, 12, 14, 0, 9, 12, 0, 107, 10, 1, 1, 83, 10, 2, 0, 135, 12, 128, 0, 3, 9, 10, 0, 135, 12, 10, 0, 3, 0, 0, 0, 121, 12, 3, 0, 135, 12, 8, 0, 1, 2, 9, 0, 83, 7, 8, 0, 83, 5, 6, 0, 2, 12, 0, 0, 24, 204, 16, 0, 2, 14, 0, 0, 24, 204, 16, 0, 79, 14, 14, 0, 41, 13, 4, 24, 42, 13, 13, 24, 41, 15, 9, 24, 42, 15, 15, 24, 14, 13, 13, 15, 20, 14, 14, 13, 83, 12, 14, 0, 2, 14, 0, 0, 192, 3, 16, 0, 27, 12, 3, 120, 3, 10, 14, 12, 1, 14, 1, 0, 107, 10, 12, 14, 25, 10, 10, 6, 80, 14, 10, 0, 39, 14, 14, 4, 84, 10, 14, 0, 2, 14, 0, 0, 192, 3, 16, 0, 27, 12, 0, 120, 3, 14, 14, 12, 25, 10, 14, 116, 82, 0, 10, 0, 34, 12, 0, 1, 121, 12, 4, 0, 1, 12, 0, 0, 0, 14, 12, 0, 119, 0, 3, 0, 26, 12, 0, 1, 0, 14, 12, 0, 85, 10, 14, 0, 137, 11, 0, 0, 139, 0, 0, 0, 140, 0, 14, 0, 0, 0, 0, 0, 2, 6, 0, 0, 194, 200, 16, 0, 2, 7, 0, 0, 174, 198, 16, 0, 2, 8, 0, 0, 172, 198, 16, 0, 136, 9, 0, 0, 0, 0, 9, 0, 136, 9, 0, 0, 25, 9, 9, 48, 137, 9, 0, 0, 25, 2, 0, 32, 25, 1, 0, 24, 1, 11, 0, 0, 135, 10, 122, 0, 11, 0, 0, 0, 135, 9, 129, 0, 10, 0, 0, 0, 135, 9, 130, 0, 135, 9, 131, 0, 135, 9, 132, 0, 135, 9, 133, 0, 135, 9, 134, 0, 134, 9, 0, 0, 128, 69, 0, 0, 78, 9, 8, 0, 120, 9, 94, 0, 134, 9, 0, 0, 148, 225, 0, 0, 2, 3, 0, 0, 194, 200, 16, 0, 2, 4, 0, 0, 166, 140, 15, 0, 25, 5, 3, 10, 78, 9, 4, 0, 83, 3, 9, 0, 25, 3, 3, 1, 25, 4, 4, 1, 54, 9, 3, 5, 248, 145, 0, 0, 2, 3, 0, 0, 218, 200, 16, 0, 2, 4, 0, 0, 176, 140, 15, 0, 25, 5, 3, 11, 78, 9, 4, 0, 83, 3, 9, 0, 25, 3, 3, 1, 25, 4, 4, 1, 54, 9, 3, 5, 36, 146, 0, 0, 135, 9, 135, 0, 135, 9, 136, 0, 135, 9, 137, 0, 135, 9, 138, 0, 135, 9, 139, 0, 1, 10, 1, 0, 79, 11, 7, 0, 134, 9, 0, 0, 244, 201, 0, 0, 10, 11, 0, 0, 134, 9, 0, 0, 12, 99, 0, 0, 135, 9, 51, 0, 1, 11, 0, 0, 79, 10, 7, 0, 134, 9, 0, 0, 244, 201, 0, 0, 11, 10, 0, 0, 1, 10, 1, 0, 1, 11, 0, 0, 135, 9, 140, 0, 10, 11, 0, 0, 1, 11, 2, 0, 1, 10, 0, 0, 1, 13, 70, 0, 135, 12, 39, 0, 13, 0, 0, 0, 135, 9, 141, 0, 11, 10, 12, 0, 1, 12, 8, 0, 1, 10, 0, 0, 135, 9, 140, 0, 12, 10, 0, 0, 1, 10, 9, 0, 1, 12, 0, 0, 135, 9, 140, 0, 10, 12, 0, 0, 2, 12, 0, 0, 187, 140, 15, 0, 1, 10, 23, 0, 134, 9, 0, 0, 100, 119, 0, 0, 12, 0, 10, 0, 78, 9, 0, 0, 121, 9, 15, 0, 135, 9, 81, 0, 6, 0, 0, 0, 2, 10, 0, 0, 201, 140, 15, 0, 1, 12, 23, 0, 134, 9, 0, 0, 100, 119, 0, 0, 10, 0, 12, 0, 78, 9, 0, 0, 121, 9, 5, 0, 2, 12, 0, 0, 218, 200, 16, 0, 135, 9, 81, 0, 12, 0, 0, 0, 2, 9, 0, 0, 168, 198, 16, 0, 1, 12, 1, 0, 85, 9, 12, 0, 85, 2, 6, 0, 2, 9, 0, 0, 231, 140, 15, 0, 135, 12, 23, 0, 9, 2, 0, 0, 119, 0, 15, 0, 1, 12, 0, 0, 83, 8, 12, 0, 134, 12, 0, 0, 148, 225, 0, 0, 135, 12, 56, 0, 2, 12, 0, 0, 168, 198, 16, 0, 1, 9, 1, 0, 85, 12, 9, 0, 85, 1, 6, 0, 2, 12, 0, 0, 118, 140, 15, 0, 135, 9, 23, 0, 12, 1, 0, 0, 134, 9, 0, 0, 96, 44, 0, 0, 119, 0, 139, 255, 140, 0, 15, 0, 0, 0, 0, 0, 2, 6, 0, 0, 144, 226, 14, 0, 2, 7, 0, 0, 147, 0, 0, 0, 2, 8, 0, 0, 149, 0, 0, 0, 135, 9, 55, 0, 1, 1, 0, 0, 1, 0, 255, 255, 1, 10, 0, 0, 135, 9, 49, 0, 10, 0, 0, 0, 1, 2, 0, 0, 13, 11, 2, 1, 1, 12, 112, 0, 1, 13, 7, 0, 125, 10, 11, 12, 13, 0, 0, 0, 135, 9, 11, 0, 10, 0, 0, 0, 27, 9, 2, 12, 3, 5, 6, 9, 103, 10, 5, 1, 79, 13, 5, 0, 106, 12, 5, 4, 135, 9, 50, 0, 10, 13, 12, 0, 25, 2, 2, 1, 33, 9, 2, 78, 120, 9, 240, 255, 1, 12, 7, 0, 135, 9, 11, 0, 12, 0, 0, 0, 1, 12, 18, 0, 1, 13, 63, 0, 2, 10, 0, 0, 220, 123, 15, 0, 135, 9, 50, 0, 12, 13, 10, 0, 33, 2, 0, 0, 1, 9, 255, 255, 47, 9, 9, 0, 140, 148, 0, 0, 1, 13, 15, 0, 1, 12, 4, 0, 125, 10, 2, 13, 12, 0, 0, 0, 135, 9, 11, 0, 10, 0, 0, 0, 1, 10, 19, 0, 1, 12, 63, 0, 2, 11, 0, 0, 234, 123, 15, 0, 2, 14, 0, 0, 247, 123, 15, 0, 125, 13, 2, 11, 14, 0, 0, 0, 135, 9, 50, 0, 10, 12, 13, 0, 1, 0, 255, 255, 134, 3, 0, 0, 4, 229, 0, 0, 1, 9, 13, 0, 1, 13, 140, 0, 138, 3, 9, 13, 212, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 224, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 228, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 232, 150, 0, 0, 208, 150, 0, 0, 236, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 208, 150, 0, 0, 240, 150, 0, 0, 208, 150, 0, 0, 248, 150, 0, 0, 0, 151, 0, 0, 208, 150, 0, 0, 4, 151, 0, 0, 119, 0, 60, 255, 135, 0, 142, 0, 1, 3, 0, 0, 119, 0, 57, 255, 119, 0, 52, 0, 119, 0, 252, 255, 119, 0, 251, 255, 119, 0, 250, 255, 1, 2, 10, 0, 119, 0, 5, 0, 1, 2, 12, 0, 119, 0, 3, 0, 119, 0, 254, 255, 119, 0, 251, 255, 32, 9, 2, 10, 121, 9, 10, 0, 25, 9, 1, 78, 13, 12, 3, 7, 1, 10, 255, 255, 1, 14, 1, 0, 125, 13, 12, 10, 14, 0, 0, 0, 3, 9, 9, 13, 30, 1, 9, 78, 119, 0, 36, 255, 32, 9, 2, 12, 121, 9, 34, 255, 27, 9, 1, 12, 3, 5, 6, 9, 78, 4, 5, 0, 102, 5, 5, 1, 13, 9, 3, 8, 1, 13, 77, 0, 1, 14, 79, 0, 125, 3, 9, 13, 14, 0, 0, 0, 1, 2, 0, 0, 3, 14, 3, 1, 30, 1, 14, 78, 27, 14, 1, 12, 90, 14, 6, 14, 41, 13, 4, 24, 42, 13, 13, 24, 46, 14, 14, 13, 160, 151, 0, 0, 27, 14, 1, 12, 3, 14, 6, 14, 102, 14, 14, 1, 41, 13, 5, 24, 42, 13, 13, 24, 52, 14, 14, 13, 192, 147, 0, 0, 25, 2, 2, 1, 35, 14, 2, 78, 120, 14, 239, 255, 119, 0, 5, 255, 135, 14, 56, 0, 1, 13, 7, 0, 135, 14, 11, 0, 13, 0, 0, 0, 139, 0, 0, 0, 140, 0, 14, 0, 0, 0, 0, 0, 2, 8, 0, 0, 192, 3, 16, 0, 2, 9, 0, 0, 74, 200, 16, 0, 2, 10, 0, 0, 59, 4, 16, 0, 2, 11, 0, 0, 73, 200, 16, 0, 78, 0, 11, 0, 41, 11, 0, 24, 42, 11, 11, 24, 121, 11, 116, 0, 1, 11, 255, 0, 19, 11, 0, 11, 0, 5, 11, 0, 27, 11, 5, 120, 3, 11, 8, 11, 25, 4, 11, 6, 80, 0, 4, 0, 2, 11, 0, 0, 255, 255, 0, 0, 19, 11, 0, 11, 0, 3, 11, 0, 1, 11, 132, 0, 19, 11, 3, 11, 32, 11, 11, 4, 121, 11, 90, 0, 27, 11, 5, 120, 3, 7, 8, 11, 25, 6, 7, 3, 78, 11, 10, 0, 78, 12, 6, 0, 4, 1, 11, 12, 25, 7, 7, 4, 2, 12, 0, 0, 60, 4, 16, 0, 78, 12, 12, 0, 78, 11, 7, 0, 4, 2, 12, 11, 1, 11, 0, 16, 19, 11, 3, 11, 120, 11, 20, 0, 5, 11, 2, 2, 5, 12, 1, 1, 3, 3, 11, 12, 1, 11, 3, 0, 48, 11, 11, 3, 164, 152, 0, 0, 27, 11, 5, 120, 3, 11, 8, 11, 102, 11, 11, 14, 32, 11, 11, 83, 0, 12, 11, 0, 119, 0, 3, 0, 1, 11, 0, 0, 0, 12, 11, 0, 121, 12, 3, 0, 1, 1, 6, 0, 119, 0, 4, 0, 1, 1, 7, 0, 119, 0, 2, 0, 1, 1, 6, 0, 32, 12, 1, 6, 121, 12, 7, 0, 1, 1, 0, 0, 27, 12, 5, 120, 3, 12, 8, 12, 102, 12, 12, 9, 121, 12, 2, 0, 1, 1, 7, 0, 32, 12, 1, 7, 121, 12, 7, 0, 134, 12, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 78, 12, 9, 0, 120, 12, 51, 0, 80, 0, 4, 0, 1, 12, 0, 32, 19, 12, 0, 12, 121, 12, 7, 0, 134, 12, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 78, 12, 9, 0, 120, 12, 42, 0, 80, 0, 4, 0, 78, 12, 10, 0, 78, 11, 6, 0, 4, 6, 12, 11, 5, 6, 6, 6, 2, 11, 0, 0, 60, 4, 16, 0, 78, 11, 11, 0, 78, 12, 7, 0, 4, 7, 11, 12, 1, 12, 0, 64, 19, 12, 0, 12, 33, 12, 12, 0, 1, 11, 3, 0, 5, 13, 7, 7, 3, 13, 13, 6, 16, 11, 11, 13, 19, 12, 12, 11, 121, 12, 6, 0, 134, 12, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 78, 12, 9, 0, 120, 12, 18, 0, 27, 12, 5, 120, 3, 12, 8, 12, 25, 7, 12, 9, 78, 12, 7, 0, 40, 12, 12, 1, 83, 7, 12, 0, 27, 12, 5, 120, 3, 12, 8, 12, 102, 0, 12, 1, 41, 12, 0, 24, 42, 12, 12, 24, 120, 12, 2, 0, 119, 0, 5, 0, 1, 12, 255, 0, 19, 12, 0, 12, 0, 5, 12, 0, 119, 0, 145, 255, 139, 0, 0, 0, 140, 0, 9, 0, 0, 0, 0, 0, 136, 5, 0, 0, 0, 3, 5, 0, 136, 5, 0, 0, 25, 5, 5, 16, 137, 5, 0, 0, 25, 2, 3, 8, 2, 5, 0, 0, 64, 4, 16, 0, 78, 5, 5, 0, 120, 5, 6, 0, 2, 6, 0, 0, 84, 134, 15, 0, 135, 5, 23, 0, 6, 3, 0, 0, 119, 0, 227, 0, 2, 5, 0, 0, 39, 102, 15, 0, 1, 6, 0, 0, 134, 0, 0, 0, 60, 213, 0, 0, 5, 6, 0, 0, 121, 0, 250, 255, 2, 6, 0, 0, 192, 3, 16, 0, 27, 5, 0, 120, 3, 6, 6, 5, 102, 6, 6, 77, 1, 7, 173, 255, 1, 8, 108, 0, 138, 6, 7, 8, 0, 156, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 60, 156, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 136, 156, 0, 0, 140, 156, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 216, 156, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 252, 155, 0, 0, 20, 157, 0, 0, 119, 0, 79, 0, 2, 8, 0, 0, 192, 3, 16, 0, 27, 5, 0, 120, 3, 8, 8, 5, 103, 1, 8, 79, 2, 8, 0, 0, 5, 204, 16, 0, 1, 5, 1, 0, 95, 8, 1, 5, 2, 5, 0, 0, 130, 206, 16, 0, 27, 8, 1, 21, 1, 7, 0, 0, 95, 5, 8, 7, 119, 0, 64, 0, 2, 7, 0, 0, 192, 3, 16, 0, 27, 8, 0, 120, 3, 4, 7, 8, 103, 1, 4, 79, 2, 8, 0, 0, 19, 204, 16, 0, 1, 7, 1, 0, 95, 8, 1, 7, 25, 4, 4, 76, 78, 7, 4, 0, 39, 7, 7, 2, 83, 4, 7, 0, 2, 7, 0, 0, 168, 207, 16, 0, 27, 8, 1, 21, 1, 5, 0, 0, 95, 7, 8, 5, 119, 0, 45, 0, 119, 0, 35, 0, 2, 5, 0, 0, 192, 3, 16, 0, 27, 8, 0, 120, 3, 1, 5, 8, 103, 4, 1, 79, 2, 8, 0, 0, 232, 203, 16, 0, 1, 5, 1, 0, 95, 8, 4, 5, 25, 1, 1, 76, 78, 5, 1, 0, 39, 5, 5, 2, 83, 1, 5, 0, 2, 5, 0, 0, 33, 204, 16, 0, 27, 8, 4, 21, 1, 7, 0, 0, 95, 5, 8, 7, 119, 0, 25, 0, 2, 5, 0, 0, 192, 3, 16, 0, 27, 7, 0, 120, 3, 5, 5, 7, 103, 1, 5, 79, 2, 5, 0, 0, 246, 203, 16, 0, 1, 7, 1, 0, 95, 5, 1, 7, 2, 7, 0, 0, 71, 205, 16, 0, 27, 5, 1, 21, 1, 8, 0, 0, 95, 7, 5, 8, 119, 0, 10, 0, 2, 5, 0, 0, 192, 3, 16, 0, 27, 8, 0, 120, 3, 5, 5, 8, 25, 4, 5, 76, 78, 5, 4, 0, 39, 5, 5, 2, 83, 4, 5, 0, 119, 0, 1, 0, 2, 6, 0, 0, 192, 3, 16, 0, 27, 7, 0, 120, 3, 6, 6, 7, 25, 1, 6, 76, 2, 6, 0, 0, 192, 3, 16, 0, 27, 7, 0, 120, 3, 6, 6, 7, 102, 6, 6, 81, 121, 6, 4, 0, 78, 6, 1, 0, 39, 6, 6, 64, 83, 1, 6, 0, 1, 7, 0, 0, 135, 6, 28, 0, 0, 7, 0, 0, 2, 6, 0, 0, 242, 200, 16, 0, 85, 2, 6, 0, 2, 7, 0, 0, 134, 134, 15, 0, 135, 6, 23, 0, 7, 2, 0, 0, 137, 3, 0, 0, 139, 0, 0, 0, 140, 1, 10, 0, 0, 0, 0, 0, 136, 7, 0, 0, 0, 6, 7, 0, 136, 7, 0, 0, 25, 7, 7, 16, 137, 7, 0, 0, 0, 5, 6, 0, 134, 7, 0, 0, 100, 203, 0, 0, 120, 7, 6, 0, 2, 7, 0, 0, 76, 200, 16, 0, 1, 8, 0, 0, 83, 7, 8, 0, 119, 0, 183, 0, 2, 8, 0, 0, 60, 4, 16, 0, 78, 2, 8, 0, 2, 8, 0, 0, 59, 4, 16, 0, 78, 1, 8, 0, 135, 7, 33, 0, 2, 1, 0, 0, 135, 8, 127, 0, 7, 0, 0, 0, 121, 8, 15, 0, 2, 8, 0, 0, 187, 200, 16, 0, 78, 3, 8, 0, 2, 8, 0, 0, 186, 200, 16, 0, 78, 4, 8, 0, 3, 2, 2, 3, 3, 1, 1, 4, 135, 7, 33, 0, 2, 1, 0, 0, 135, 8, 127, 0, 7, 0, 0, 0, 33, 8, 8, 0, 120, 8, 249, 255, 135, 4, 34, 0, 2, 1, 0, 0, 121, 4, 141, 0, 2, 8, 0, 0, 192, 3, 16, 0, 27, 7, 4, 120, 3, 8, 8, 7, 102, 8, 8, 14, 32, 8, 8, 70, 121, 8, 9, 0, 2, 8, 0, 0, 62, 4, 16, 0, 2, 7, 0, 0, 62, 4, 16, 0, 80, 7, 7, 0, 1, 9, 127, 255, 19, 7, 7, 9, 84, 8, 7, 0, 135, 7, 10, 0, 4, 0, 0, 0, 121, 7, 11, 0, 1, 8, 23, 0, 135, 7, 2, 0, 8, 0, 0, 0, 2, 8, 0, 0, 192, 3, 16, 0, 27, 9, 4, 120, 3, 8, 8, 9, 102, 8, 8, 11, 135, 7, 8, 0, 2, 1, 8, 0, 25, 1, 5, 1, 135, 8, 77, 0, 135, 7, 78, 0, 8, 5, 0, 0, 78, 2, 1, 0, 78, 3, 5, 0, 41, 8, 2, 24, 42, 8, 8, 24, 41, 9, 3, 24, 42, 9, 9, 24, 135, 7, 33, 0, 8, 9, 0, 0, 1, 9, 177, 0, 1, 8, 74, 0, 138, 7, 9, 8, 40, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0], eb + 30720);
    HEAPU8.set([36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 36, 160, 0, 0, 44, 160, 0, 0, 119, 0, 168, 255, 119, 0, 2, 0, 119, 0, 1, 0, 135, 7, 0, 0, 5, 0, 0, 0, 1, 9, 255, 0, 19, 7, 7, 9, 0, 1, 7, 0, 2, 7, 0, 0, 192, 3, 16, 0, 27, 9, 4, 120, 3, 5, 7, 9, 107, 5, 13, 1, 107, 5, 3, 3, 107, 5, 4, 2, 1, 7, 64, 0, 107, 5, 11, 7, 1, 9, 1, 0, 107, 5, 12, 9, 25, 5, 5, 6, 80, 9, 5, 0, 39, 9, 9, 4, 84, 5, 9, 0, 2, 9, 0, 0, 192, 3, 16, 0, 27, 7, 0, 120, 3, 9, 9, 7, 25, 5, 9, 116, 82, 0, 5, 0, 34, 7, 0, 1, 121, 7, 4, 0, 1, 7, 0, 0, 0, 9, 7, 0, 119, 0, 3, 0, 26, 7, 0, 1, 0, 9, 7, 0, 85, 5, 9, 0, 137, 6, 0, 0, 139, 0, 0, 0, 140, 0, 15, 0, 0, 0, 0, 0, 2, 8, 0, 0, 20, 1, 4, 0, 2, 9, 0, 0, 192, 3, 16, 0, 2, 10, 0, 0, 0, 132, 15, 0, 136, 11, 0, 0, 0, 6, 11, 0, 136, 11, 0, 0, 25, 11, 11, 48, 137, 11, 0, 0, 25, 5, 6, 32, 25, 4, 6, 24, 25, 3, 6, 16, 25, 2, 6, 8, 0, 0, 6, 0, 2, 11, 0, 0, 158, 131, 15, 0, 1, 12, 5, 0, 134, 1, 0, 0, 60, 213, 0, 0, 11, 12, 0, 0, 121, 1, 139, 0, 27, 12, 1, 120, 3, 12, 9, 12, 102, 12, 12, 77, 33, 12, 12, 5, 121, 12, 6, 0, 2, 11, 0, 0, 162, 131, 15, 0, 135, 12, 23, 0, 11, 0, 0, 0, 119, 0, 129, 0, 1, 11, 6, 0, 135, 12, 2, 0, 11, 0, 0, 0, 27, 12, 1, 120, 3, 12, 9, 12, 25, 7, 12, 100, 82, 0, 7, 0, 26, 12, 0, 1, 85, 7, 12, 0, 34, 12, 0, 2, 121, 12, 17, 0, 2, 12, 0, 0, 152, 200, 16, 0, 2, 11, 0, 0, 152, 200, 16, 0, 82, 11, 11, 0, 26, 11, 11, 1, 85, 12, 11, 0, 1, 11, 255, 0, 19, 11, 1, 11, 0, 7, 11, 0, 2, 12, 0, 0, 64, 4, 16, 0, 135, 11, 5, 0, 12, 7, 0, 0, 135, 11, 29, 0, 7, 0, 0, 0, 2, 11, 0, 0, 172, 200, 16, 0, 82, 0, 11, 0, 34, 11, 0, 0, 121, 11, 6, 0, 2, 11, 0, 0, 172, 200, 16, 0, 1, 12, 0, 0, 85, 11, 12, 0, 119, 0, 15, 0, 1, 12, 188, 7, 47, 12, 12, 0, 24, 162, 0, 0, 1, 11, 5, 0, 135, 12, 1, 0, 11, 0, 0, 0, 25, 7, 12, 2, 2, 12, 0, 0, 148, 200, 16, 0, 2, 11, 0, 0, 148, 200, 16, 0, 82, 11, 11, 0, 3, 11, 7, 11, 85, 12, 11, 0, 1, 12, 20, 5, 135, 11, 39, 0, 12, 0, 0, 0, 1, 12, 200, 0, 4, 7, 11, 12, 1, 11, 144, 1, 135, 12, 1, 0, 11, 0, 0, 0, 3, 7, 7, 12, 2, 12, 0, 0, 172, 200, 16, 0, 82, 12, 12, 0, 3, 7, 7, 12, 2, 12, 0, 0, 172, 200, 16, 0, 1, 13, 208, 7, 15, 13, 7, 13, 1, 14, 208, 7, 125, 11, 13, 7, 14, 0, 0, 0, 85, 12, 11, 0, 2, 11, 0, 0, 180, 200, 16, 0, 1, 12, 0, 0, 85, 11, 12, 0, 2, 12, 0, 0, 98, 200, 16, 0, 79, 12, 12, 0, 45, 12, 1, 12, 160, 162, 0, 0, 2, 12, 0, 0, 98, 200, 16, 0, 1, 11, 0, 0, 83, 12, 11, 0, 27, 11, 1, 120, 3, 11, 9, 11, 102, 11, 11, 79, 32, 11, 11, 1, 121, 11, 9, 0, 2, 11, 0, 0, 218, 200, 16, 0, 85, 2, 11, 0, 2, 12, 0, 0, 202, 131, 15, 0, 135, 11, 23, 0, 12, 2, 0, 0, 119, 0, 23, 0, 1, 11, 70, 0, 1, 14, 100, 0, 135, 12, 1, 0, 14, 0, 0, 0, 47, 11, 11, 12, 32, 163, 0, 0, 2, 11, 0, 0, 80, 4, 16, 0, 2, 12, 0, 0, 80, 4, 16, 0, 82, 12, 12, 0, 25, 12, 12, 1, 85, 11, 12, 0, 2, 11, 0, 0, 227, 131, 15, 0, 135, 12, 23, 0, 11, 3, 0, 0, 135, 12, 143, 0, 119, 0, 4, 0, 135, 12, 23, 0, 10, 4, 0, 0, 119, 0, 1, 0, 2, 12, 0, 0, 148, 200, 16, 0, 82, 12, 12, 0, 121, 12, 5, 0, 2, 11, 0, 0, 23, 132, 15, 0, 135, 12, 23, 0, 11, 5, 0, 0, 137, 6, 0, 0, 139, 0, 0, 0, 140, 2, 19, 0, 0, 0, 0, 0, 2, 14, 0, 0, 163, 49, 4, 0, 136, 15, 0, 0, 0, 9, 15, 0, 136, 15, 0, 0, 25, 15, 15, 32, 137, 15, 0, 0, 25, 6, 9, 28, 25, 7, 9, 24, 25, 2, 9, 20, 25, 3, 9, 16, 0, 8, 9, 0, 2, 15, 0, 0, 164, 198, 16, 0, 82, 15, 15, 0, 120, 15, 92, 0, 120, 1, 4, 0, 135, 15, 144, 0, 6, 7, 2, 3, 119, 0, 5, 0, 1, 15, 128, 2, 85, 6, 15, 0, 1, 15, 32, 1, 85, 7, 15, 0, 135, 5, 145, 0, 135, 15, 145, 0, 4, 1, 15, 5, 1, 15, 239, 1, 50, 15, 1, 15, 8, 165, 0, 0, 32, 2, 0, 0, 25, 3, 8, 4, 25, 0, 8, 8, 25, 4, 8, 12, 43, 15, 1, 4, 0, 11, 15, 0, 2, 15, 0, 0, 48, 64, 12, 0, 121, 2, 5, 0, 1, 17, 30, 0, 4, 17, 17, 11, 0, 16, 17, 0, 119, 0, 2, 0, 0, 16, 11, 0, 41, 16, 16, 3, 98, 12, 15, 16, 2, 16, 0, 0, 140, 198, 16, 0, 82, 16, 16, 0, 1, 17, 0, 0, 135, 15, 146, 0, 16, 17, 0, 0, 59, 15, 1, 0, 64, 13, 15, 12, 82, 15, 6, 0, 76, 15, 15, 0, 65, 15, 13, 15, 75, 15, 15, 0, 85, 8, 15, 0, 82, 15, 7, 0, 76, 15, 15, 0, 65, 15, 13, 15, 75, 15, 15, 0, 85, 3, 15, 0, 59, 15, 0, 5, 65, 15, 12, 15, 75, 11, 15, 0, 85, 0, 11, 0, 59, 15, 64, 2, 65, 15, 12, 15, 75, 10, 15, 0, 85, 4, 10, 0, 2, 17, 0, 0, 140, 198, 16, 0, 82, 17, 17, 0, 135, 15, 147, 0, 17, 11, 10, 0, 2, 17, 0, 0, 140, 198, 16, 0, 82, 17, 17, 0, 2, 16, 0, 0, 144, 198, 16, 0, 82, 16, 16, 0, 1, 18, 0, 0, 135, 15, 148, 0, 17, 16, 8, 18, 2, 18, 0, 0, 140, 198, 16, 0, 82, 18, 18, 0, 1, 16, 0, 0, 1, 17, 0, 0, 135, 15, 147, 0, 18, 16, 17, 0, 135, 15, 149, 0, 2, 17, 0, 0, 140, 198, 16, 0, 82, 17, 17, 0, 135, 15, 150, 0, 17, 0, 0, 0, 1, 17, 1, 0, 135, 15, 151, 0, 17, 0, 0, 0, 135, 15, 145, 0, 4, 1, 15, 5, 1, 15, 239, 1, 57, 15, 1, 15, 228, 163, 0, 0, 137, 9, 0, 0, 139, 0, 0, 0, 140, 1, 24, 0, 0, 0, 0, 0, 2, 15, 0, 0, 166, 49, 4, 0, 2, 16, 0, 0, 0, 5, 0, 0, 2, 17, 0, 0, 1, 4, 0, 0, 136, 18, 0, 0, 0, 13, 18, 0, 136, 18, 0, 0, 25, 18, 18, 80, 137, 18, 0, 0, 0, 1, 13, 0, 25, 4, 13, 56, 135, 5, 145, 0, 25, 7, 1, 16, 25, 8, 7, 4, 25, 9, 7, 8, 25, 10, 1, 20, 25, 11, 4, 8, 25, 12, 1, 24, 25, 2, 4, 4, 25, 3, 4, 12, 1, 19, 5, 0, 135, 18, 151, 0, 19, 0, 0, 0, 135, 18, 152, 0, 1, 0, 0, 0, 121, 18, 55, 1, 82, 18, 1, 0, 1, 19, 0, 3, 1, 20, 2, 1, 138, 18, 19, 20, 164, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 160, 169, 0, 0, 204, 169, 0, 0, 119, 0, 44, 0, 81, 14, 9, 0, 82, 22, 8, 0, 38, 21, 14, 3, 1, 23, 192, 0, 19, 23, 14, 23, 135, 20, 153, 0, 22, 21, 23, 0, 135, 19, 154, 0, 20, 0, 0, 0, 119, 0, 34, 0, 78, 19, 7, 0, 32, 19, 19, 1, 121, 19, 31, 0, 135, 19, 155, 0, 4, 0, 0, 0, 82, 19, 10, 0, 82, 20, 4, 0, 4, 19, 19, 20, 5, 19, 19, 16, 82, 20, 11, 0, 6, 14, 19, 20, 2, 20, 0, 0, 152, 198, 16, 0, 85, 20, 14, 0, 82, 20, 12, 0, 82, 19, 2, 0, 4, 20, 20, 19, 1, 19, 64, 2, 5, 20, 20, 19, 82, 19, 3, 0, 6, 6, 20, 19, 2, 19, 0, 0, 156, 198, 16, 0, 85, 19, 6, 0, 135, 6, 156, 0, 14, 6, 0, 0, 32, 21, 6, 0, 1, 22, 0, 2, 125, 20, 21, 22, 6, 0, 0, 0, 135, 19, 154, 0, 20, 0, 0, 0, 119, 0, 1, 0, 135, 18, 152, 0, 1, 0, 0, 0, 120, 18, 204, 254, 119, 0, 1, 0, 135, 6, 157, 0, 32, 18, 6, 0, 135, 19, 145, 0, 4, 19, 19, 5, 16, 19, 19, 0, 19, 18, 18, 19, 120, 18, 190, 254, 137, 13, 0, 0, 139, 6, 0, 0, 140, 0, 13, 0, 0, 0, 0, 0, 2, 7, 0, 0, 242, 200, 16, 0, 2, 8, 0, 0, 192, 3, 16, 0, 136, 9, 0, 0, 0, 6, 9, 0, 136, 9, 0, 0, 25, 9, 9, 32, 137, 9, 0, 0, 25, 5, 6, 16, 25, 4, 6, 8, 2, 9, 0, 0, 76, 200, 16, 0, 1, 10, 0, 0, 83, 9, 10, 0, 2, 10, 0, 0, 12, 129, 15, 0, 1, 9, 255, 255, 134, 0, 0, 0, 60, 213, 0, 0, 10, 9, 0, 0, 121, 0, 198, 0, 27, 9, 0, 120, 3, 9, 8, 9, 103, 3, 9, 79, 27, 9, 0, 120, 3, 9, 8, 9, 102, 9, 9, 77, 1, 11, 173, 255, 1, 10, 97, 0, 138, 9, 11, 10, 160, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 224, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 32, 173, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 140, 172, 0, 0, 96, 173, 0, 0, 2, 10, 0, 0, 17, 129, 15, 0, 135, 11, 23, 0, 10, 6, 0, 0, 119, 0, 87, 0, 2, 11, 0, 0, 64, 230, 14, 0, 2, 10, 0, 0, 68, 210, 16, 0, 41, 12, 3, 2, 94, 10, 10, 12, 41, 10, 10, 2, 94, 1, 11, 10, 2, 11, 0, 0, 130, 206, 16, 0, 27, 10, 3, 21, 3, 2, 11, 10, 2, 10, 0, 0, 5, 204, 16, 0, 3, 0, 10, 3, 119, 0, 45, 0, 2, 10, 0, 0, 144, 231, 14, 0, 2, 11, 0, 0, 124, 210, 16, 0, 41, 12, 3, 2, 94, 11, 11, 12, 41, 11, 11, 2, 94, 1, 10, 11, 2, 10, 0, 0, 168, 207, 16, 0, 27, 11, 3, 21, 3, 2, 10, 11, 2, 11, 0, 0, 19, 204, 16, 0, 3, 0, 11, 3, 119, 0, 29, 0, 2, 10, 0, 0, 176, 230, 14, 0, 2, 11, 0, 0, 12, 210, 16, 0, 41, 12, 3, 2, 94, 11, 11, 12, 41, 11, 11, 2, 94, 1, 10, 11, 2, 10, 0, 0, 33, 204, 16, 0, 27, 11, 3, 21, 3, 2, 10, 11, 2, 11, 0, 0, 232, 203, 16, 0, 3, 0, 11, 3, 119, 0, 13, 0, 2, 10, 0, 0, 206, 208, 16, 0, 27, 11, 3, 21, 3, 1, 10, 11, 2, 11, 0, 0, 71, 205, 16, 0, 27, 10, 3, 21, 3, 2, 11, 10, 2, 10, 0, 0, 246, 203, 16, 0, 3, 0, 10, 3, 119, 0, 1, 0, 78, 9, 0, 0, 121, 9, 6, 0, 2, 11, 0, 0, 47, 129, 15, 0, 135, 9, 23, 0, 11, 4, 0, 0, 119, 0, 20, 0, 78, 11, 2, 0, 32, 11, 11, 0, 125, 9, 11, 1, 2, 0, 0, 0, 85, 5, 9, 0, 2, 11, 0, 0, 81, 129, 15, 0, 135, 9, 23, 0, 11, 5, 0, 0, 2, 11, 0, 0, 97, 129, 15, 0, 1, 10, 20, 0, 134, 9, 0, 0, 100, 119, 0, 0, 11, 7, 10, 0, 78, 9, 7, 0, 121, 9, 3, 0, 135, 9, 81, 0, 2, 7, 0, 0, 137, 6, 0, 0, 139, 0, 0, 0, 140, 0, 9, 0, 0, 0, 0, 0, 2, 4, 0, 0, 74, 200, 16, 0, 2, 5, 0, 0, 220, 211, 16, 0, 2, 6, 0, 0, 236, 210, 16, 0, 48, 7, 6, 5, 20, 175, 0, 0, 2, 0, 0, 0, 236, 210, 16, 0, 82, 1, 0, 0, 121, 1, 53, 0, 25, 2, 0, 8, 82, 3, 2, 0, 1, 7, 0, 0, 47, 7, 7, 3, 8, 175, 0, 0, 26, 3, 3, 1, 85, 2, 3, 0, 120, 3, 45, 0, 1, 7, 1, 0, 1, 8, 10, 0, 138, 1, 7, 8, 144, 174, 0, 0, 152, 174, 0, 0, 160, 174, 0, 0, 168, 174, 0, 0, 176, 174, 0, 0, 184, 174, 0, 0, 192, 174, 0, 0, 200, 174, 0, 0, 220, 174, 0, 0, 240, 174, 0, 0, 119, 0, 29, 0, 135, 7, 41, 0, 119, 0, 27, 0, 135, 7, 158, 0, 119, 0, 25, 0, 135, 7, 159, 0, 119, 0, 23, 0, 135, 7, 160, 0, 119, 0, 21, 0, 135, 7, 161, 0, 119, 0, 19, 0, 135, 7, 162, 0, 119, 0, 17, 0, 135, 7, 163, 0, 119, 0, 15, 0, 134, 7, 0, 0, 108, 191, 0, 0, 78, 7, 4, 0, 121, 7, 11, 0, 119, 0, 15, 0, 134, 7, 0, 0, 196, 151, 0, 0, 78, 7, 4, 0, 121, 7, 6, 0, 119, 0, 10, 0, 106, 8, 0, 4, 135, 7, 79, 0, 8, 0, 0, 0, 119, 0, 1, 0, 1, 7, 0, 0, 85, 0, 7, 0, 25, 0, 0, 12, 55, 7, 0, 5, 48, 174, 0, 0, 139, 0, 0, 0, 140, 1, 11, 0, 0, 0, 0, 0, 2, 4, 0, 0, 99, 200, 16, 0, 2, 5, 0, 0, 98, 200, 16, 0, 2, 6, 0, 0, 192, 3, 16, 0, 136, 7, 0, 0, 0, 3, 7, 0, 136, 7, 0, 0, 25, 7, 7, 16, 137, 7, 0, 0, 0, 2, 3, 0, 120, 0, 3, 0, 1, 1, 1, 0, 119, 0, 106, 0, 2, 7, 0, 0, 97, 200, 16, 0, 79, 7, 7, 0, 13, 1, 7, 0, 120, 1, 14, 0, 79, 7, 5, 0, 46, 7, 7, 0, 164, 175, 0, 0, 79, 7, 4, 0, 46, 7, 7, 0, 164, 175, 0, 0, 2, 7, 0, 0, 100, 200, 16, 0, 79, 7, 7, 0, 46, 7, 7, 0, 164, 175, 0, 0, 1, 1, 1, 0, 119, 0, 88, 0, 27, 7, 0, 120, 3, 7, 6, 7, 102, 7, 7, 76, 38, 7, 7, 1, 121, 7, 7, 0, 2, 8, 0, 0, 242, 129, 15, 0, 135, 7, 23, 0, 8, 2, 0, 0, 1, 1, 0, 0, 119, 0, 77, 0, 79, 7, 5, 0, 45, 7, 7, 0, 236, 175, 0, 0, 1, 7, 0, 0, 83, 5, 7, 0, 1, 1, 1, 0, 119, 0, 70, 0, 121, 1, 26, 0, 1, 8, 0, 0, 135, 7, 2, 0, 8, 0, 0, 0, 134, 7, 0, 0, 124, 193, 0, 0, 2, 7, 0, 0, 74, 200, 16, 0, 78, 7, 7, 0, 121, 7, 3, 0, 1, 1, 0, 0, 119, 0, 58, 0, 134, 7, 0, 0, 0, 174, 0, 0, 2, 7, 0, 0, 74, 200, 16, 0, 78, 7, 7, 0, 121, 7, 3, 0, 1, 1, 0, 0, 119, 0, 50, 0, 2, 7, 0, 0, 97, 200, 16, 0, 1, 8, 0, 0, 83, 7, 8, 0, 1, 1, 1, 0, 119, 0, 44, 0, 79, 8, 4, 0, 45, 8, 8, 0, 104, 176, 0, 0, 1, 1, 0, 0, 119, 0, 10, 0, 2, 8, 0, 0, 100, 200, 16, 0, 79, 8, 8, 0, 45, 8, 8, 0, 132, 176, 0, 0, 1, 1, 1, 0, 119, 0, 3, 0, 1, 1, 1, 0, 119, 0, 30, 0, 1, 7, 0, 0, 95, 4, 1, 7, 27, 7, 0, 120, 3, 7, 6, 7, 102, 7, 7, 79, 1, 8, 1, 0, 1, 9, 4, 0, 138, 7, 8, 9, 196, 176, 0, 0, 188, 176, 0, 0, 188, 176, 0, 0, 232, 176, 0, 0, 1, 1, 1, 0, 119, 0, 16, 0, 1, 9, 0, 0, 27, 10, 0, 120, 3, 10, 6, 10, 106, 10, 10, 116, 4, 9, 9, 10, 135, 8, 30, 0, 9, 0, 0, 0, 1, 1, 1, 0, 119, 0, 7, 0, 135, 8, 161, 0, 1, 9, 5, 0, 135, 8, 164, 0, 9, 0, 0, 0, 1, 1, 1, 0, 119, 0, 1, 0, 137, 3, 0, 0, 139, 1, 0, 0, 140, 1, 12, 0, 0, 0, 0, 0, 1, 7, 0, 0, 136, 9, 0, 0, 0, 8, 9, 0, 136, 9, 0, 0, 25, 9, 9, 16, 137, 9, 0, 0, 0, 6, 8, 0, 134, 9, 0, 0, 100, 203, 0, 0, 120, 9, 6, 0, 2, 9, 0, 0, 76, 200, 16, 0, 1, 10, 0, 0, 83, 9, 10, 0, 119, 0, 103, 0, 135, 4, 37, 0, 1, 10, 255, 0, 19, 10, 4, 10, 0, 5, 10, 0, 41, 10, 4, 24, 42, 10, 10, 24, 121, 10, 82, 0, 2, 10, 0, 0, 25, 204, 16, 0, 1, 9, 1, 0, 83, 10, 9, 0, 2, 9, 0, 0, 192, 3, 16, 0, 27, 10, 5, 120, 3, 1, 9, 10, 1, 9, 42, 0, 107, 1, 77, 9, 25, 3, 1, 90, 1, 9, 49, 100, 84, 3, 9, 0, 2, 10, 0, 0, 49, 100, 56, 0, 43, 10, 10, 16, 108, 3, 2, 10, 1, 9, 232, 3, 109, 1, 104, 9, 1, 10, 1, 0, 109, 1, 108, 10, 1, 9, 16, 0, 107, 1, 76, 9, 2, 9, 0, 0, 98, 200, 16, 0, 78, 1, 9, 0, 41, 9, 1, 24, 42, 9, 9, 24, 121, 9, 13, 0, 2, 9, 0, 0, 192, 3, 16, 0, 27, 10, 5, 120, 3, 9, 9, 10, 2, 10, 0, 0, 192, 3, 16, 0, 1, 11, 255, 0, 19, 11, 1, 11, 27, 11, 11, 120, 3, 10, 10, 11, 102, 10, 10, 79, 107, 9, 78, 10, 2, 9, 0, 0, 187, 200, 16, 0, 78, 9, 9, 0, 2, 11, 0, 0, 186, 200, 16, 0, 78, 11, 11, 0, 134, 10, 0, 0, 188, 180, 0, 0, 5, 9, 11, 0, 2, 10, 0, 0, 192, 3, 16, 0, 27, 11, 5, 120, 3, 2, 10, 11, 25, 1, 2, 4, 25, 2, 2, 3, 78, 11, 1, 0, 78, 10, 2, 0, 135, 3, 34, 0, 11, 10, 0, 0, 120, 3, 3, 0, 1, 7, 9, 0, 119, 0, 11, 0, 1, 11, 3, 0, 135, 10, 35, 0, 11, 3, 0, 0, 120, 10, 6, 0, 78, 11, 1, 0, 78, 9, 2, 0, 135, 10, 38, 0, 11, 9, 5, 0, 119, 0, 2, 0, 1, 7, 9, 0, 32, 10, 7, 9, 121, 10, 5, 0, 2, 9, 0, 0, 32, 125, 15, 0, 135, 10, 23, 0, 9, 6, 0, 0, 135, 10, 29, 0, 4, 0, 0, 0, 2, 10, 0, 0, 192, 3, 16, 0, 27, 9, 0, 120, 3, 10, 10, 9, 25, 7, 10, 116, 82, 6, 7, 0, 34, 9, 6, 1, 121, 9, 4, 0, 1, 9, 0, 0, 0, 10, 9, 0, 119, 0, 3, 0, 26, 9, 6, 1, 0, 10, 9, 0, 85, 7, 10, 0, 137, 8, 0, 0, 139, 0, 0, 0, 140, 1, 13, 0, 0, 0, 0, 0, 2, 8, 0, 0, 192, 3, 16, 0, 2, 9, 0, 0, 31, 2, 8, 0, 136, 10, 0, 0, 0, 7, 10, 0, 136, 10, 0, 0, 25, 10, 10, 16, 137, 10, 0, 0, 25, 6, 7, 8, 0, 5, 7, 0, 134, 10, 0, 0, 100, 203, 0, 0, 120, 10, 6, 0, 2, 10, 0, 0, 76, 200, 16, 0, 1, 11, 0, 0, 83, 10, 11, 0, 119, 0, 94, 0, 2, 11, 0, 0, 60, 4, 16, 0, 78, 2, 11, 0, 2, 11, 0, 0, 59, 4, 16, 0, 78, 1, 11, 0, 135, 10, 33, 0, 2, 1, 0, 0, 135, 11, 127, 0, 10, 0, 0, 0, 121, 11, 15, 0, 2, 11, 0, 0, 187, 200, 16, 0, 78, 3, 11, 0, 2, 11, 0, 0, 186, 200, 16, 0, 78, 4, 11, 0, 3, 2, 2, 3, 3, 1, 1, 4, 135, 10, 33, 0, 2, 1, 0, 0, 135, 11, 127, 0, 10, 0, 0, 0, 33, 11, 11, 0, 120, 11, 249, 255, 135, 1, 34, 0, 2, 1, 0, 0, 121, 1, 54, 0, 27, 11, 1, 120, 3, 11, 8, 11, 102, 4, 11, 14, 1, 11, 255, 0, 19, 11, 4, 11, 0, 2, 11, 0, 41, 11, 4, 24, 42, 11, 11, 24, 32, 11, 11, 70, 121, 11, 9, 0, 2, 11, 0, 0, 62, 4, 16, 0, 2, 10, 0, 0, 62, 4, 16, 0, 80, 10, 10, 0, 1, 12, 127, 255, 19, 10, 10, 12, 84, 11, 10, 0, 27, 10, 0, 120, 3, 10, 8, 10, 102, 10, 10, 81, 45, 10, 2, 10, 68, 180, 0, 0, 2, 10, 0, 0, 240, 232, 14, 0, 26, 11, 2, 65, 27, 11, 11, 68, 3, 10, 10, 11, 116, 5, 10, 0, 2, 11, 0, 0, 75, 125, 15, 0, 135, 10, 23, 0, 11, 5, 0, 0, 1, 11, 0, 0, 135, 10, 80, 0, 1, 11, 0, 0, 119, 0, 17, 0, 1, 11, 15, 0, 135, 10, 2, 0, 11, 0, 0, 0, 2, 11, 0, 0, 111, 125, 15, 0, 135, 10, 23, 0, 11, 6, 0, 0, 27, 10, 1, 120, 3, 6, 8, 10, 1, 11, 1, 0, 107, 6, 12, 11, 25, 6, 6, 6, 80, 11, 6, 0, 39, 11, 11, 4, 84, 6, 11, 0, 119, 0, 1, 0, 27, 11, 0, 120, 3, 11, 8, 11, 25, 6, 11, 116, 82, 5, 6, 0, 34, 10, 5, 1, 121, 10, 4, 0, 1, 10, 0, 0, 0, 11, 10, 0, 119, 0, 3, 0, 26, 10, 5, 1, 0, 11, 10, 0, 85, 6, 11, 0, 137, 7, 0, 0, 139, 0, 0, 0, 140, 3, 14, 0, 0, 0, 0, 0, 2, 9, 0, 0, 72, 200, 16, 0, 2, 10, 0, 0, 192, 3, 16, 0, 27, 11, 0, 120, 3, 6, 10, 11, 25, 7, 6, 3, 2, 11, 0, 0, 59, 4, 16, 0, 79, 11, 11, 0, 2, 10, 0, 0, 60, 4, 16, 0, 79, 10, 10, 0, 41, 10, 10, 8, 20, 11, 11, 10, 0, 8, 11, 0, 83, 7, 8, 0, 42, 10, 8, 8, 107, 7, 1, 10, 25, 8, 6, 4, 1, 10, 255, 0, 19, 10, 0, 10, 0, 5, 10, 0, 25, 6, 6, 77, 1, 0, 64, 0, 41, 10, 0, 24, 42, 10, 10, 24, 33, 10, 10, 64, 121, 10, 32, 0, 78, 4, 7, 0, 78, 3, 8, 0, 41, 11, 4, 24, 42, 11, 11, 24, 2, 12, 0, 0, 59, 4, 16, 0, 78, 12, 12, 0, 45, 11, 11, 12, 124, 181, 0, 0, 41, 11, 3, 24, 42, 11, 11, 24, 2, 12, 0, 0, 60, 4, 16, 0, 78, 12, 12, 0, 13, 11, 11, 12, 0, 10, 11, 0, 119, 0, 3, 0, 1, 11, 0, 0, 0, 10, 11, 0, 120, 10, 12, 0, 41, 11, 3, 24, 42, 11, 11, 24, 41, 12, 4, 24, 42, 12, 12, 24, 135, 10, 7, 0, 11, 12, 0, 0, 121, 10, 5, 0, 78, 12, 8, 0, 78, 11, 7, 0, 135, 10, 8, 0, 12, 11, 0, 0, 79, 10, 8, 0, 3, 0, 10, 1, 83, 8, 0, 0, 79, 10, 7, 0, 3, 3, 10, 2, 83, 7, 3, 0, 41, 10, 0, 24, 42, 10, 10, 24, 0, 0, 10, 0, 41, 10, 3, 24, 42, 10, 10, 24, 0, 3, 10, 0, 135, 4, 33, 0, 0, 3, 0, 0, 1, 10, 206, 0, 14, 10, 4, 10, 135, 11, 127, 0, 4, 0, 0, 0, 33, 11, 11, 0, 19, 10, 10, 11, 120, 10, 2, 0, 119, 0, 28, 0, 135, 10, 7, 0, 0, 3, 0, 0, 120, 10, 3, 0, 1, 0, 64, 0, 119, 0, 195, 255, 2, 10, 0, 0, 128, 61, 16, 0, 78, 11, 8, 0, 26, 11, 11, 1, 78, 12, 7, 0, 27, 12, 12, 22, 3, 11, 11, 12, 90, 0, 10, 11, 135, 10, 6, 0, 9, 5, 0, 0, 78, 11, 8, 0, 78, 12, 7, 0, 78, 13, 6, 0, 135, 10, 8, 0, 11, 12, 13, 0, 135, 10, 5, 0, 9, 5, 0, 0, 1, 13, 1, 0, 134, 10, 0, 0, 204, 220, 0, 0, 13, 0, 0, 0, 119, 0, 173, 255, 139, 0, 0, 0, 140, 0, 13, 0, 0, 0, 0, 0, 2, 7, 0, 0, 76, 200, 16, 0, 2, 8, 0, 0, 192, 3, 16, 0, 2, 9, 0, 0, 99, 200, 16, 0, 136, 10, 0, 0, 0, 4, 10, 0, 136, 10, 0, 0, 25, 10, 10, 32, 137, 10, 0, 0, 25, 3, 4, 16, 25, 1, 4, 8, 0, 0, 4, 0, 2, 10, 0, 0, 48, 130, 15, 0, 1, 11, 9, 0, 134, 2, 0, 0, 60, 213, 0, 0, 10, 11, 0, 0, 120, 2, 4, 0, 1, 11, 0, 0, 83, 7, 11, 0, 119, 0, 92, 0, 27, 11, 2, 120, 3, 11, 8, 11, 102, 11, 11, 77, 33, 11, 11, 9, 121, 11, 8, 0, 2, 10, 0, 0, 55, 130, 15, 0, 135, 11, 23, 0, 10, 0, 0, 0, 1, 11, 0, 0, 83, 7, 11, 0, 119, 0, 80, 0, 135, 11, 126, 0, 2, 0, 0, 0, 121, 11, 4, 0, 1, 11, 0, 0, 83, 7, 11, 0, 119, 0, 74, 0, 78, 5, 9, 0, 2, 11, 0, 0, 100, 200, 16, 0, 78, 6, 11, 0, 41, 10, 6, 24, 42, 10, 10, 24, 32, 10, 10, 0, 121, 10, 4, 0, 1, 10, 1, 0, 0, 11, 10, 0, 119, 0, 7, 0, 41, 10, 5, 24, 42, 10, 10, 24, 33, 10, 10, 0, 41, 10, 10, 31, 42, 10, 10, 31, 0, 11, 10, 0, 0, 0, 11, 0, 20, 11, 6, 5, 41, 11, 11, 24, 42, 11, 11, 24, 120, 11, 6, 0, 134, 0, 0, 0, 116, 194, 0, 0, 34, 11, 0, 0, 121, 11, 11, 0, 119, 0, 47, 0, 34, 11, 0, 0, 121, 11, 8, 0, 2, 10, 0, 0, 90, 130, 15, 0, 135, 11, 23, 0, 10, 1, 0, 0, 1, 11, 0, 0, 83, 7, 11, 0, 119, 0, 38, 0, 95, 9, 0, 2, 27, 11, 2, 120, 3, 11, 8, 11, 102, 11, 11, 79, 1, 10, 1, 0, 1, 12, 6, 0, 138, 11, 10, 12, 244, 183, 0, 0, 240, 183, 0, 0, 240, 183, 0, 0, 12, 184, 0, 0, 240, 183, 0, 0, 20, 184, 0, 0, 119, 0, 11, 0, 27, 12, 2, 120, 3, 12, 8, 12, 106, 12, 12, 116, 135, 10, 30, 0, 12, 0, 0, 0, 119, 0, 5, 0, 135, 10, 165, 0, 119, 0, 3, 0, 135, 10, 166, 0, 119, 0, 1, 0, 1, 10, 1, 0, 135, 11, 28, 0, 2, 10, 0, 0, 135, 6, 53, 0, 2, 0, 0, 0, 2, 11, 0, 0, 242, 200, 16, 0, 85, 3, 11, 0, 109, 3, 4, 6, 2, 10, 0, 0, 128, 130, 15, 0, 135, 11, 23, 0, 10, 3, 0, 0, 137, 4, 0, 0, 139, 0, 0, 0, 140, 1, 8, 0, 0, 0, 0, 0, 134, 5, 0, 0, 100, 203, 0, 0, 120, 5, 6, 0, 2, 5, 0, 0, 76, 200, 16, 0, 1, 6, 0, 0, 83, 5, 6, 0, 119, 0, 103, 0, 2, 6, 0, 0, 60, 4, 16, 0, 78, 1, 6, 0, 2, 6, 0, 0, 59, 4, 16, 0, 78, 2, 6, 0, 135, 5, 33, 0, 1, 2, 0, 0, 135, 6, 127, 0, 5, 0, 0, 0, 120, 6, 3, 0, 0, 4, 2, 0, 119, 0, 16, 0, 2, 6, 0, 0, 187, 200, 16, 0, 78, 3, 6, 0, 2, 6, 0, 0, 186, 200, 16, 0, 78, 4, 6, 0, 3, 1, 1, 3, 3, 2, 2, 4, 135, 5, 33, 0, 1, 2, 0, 0, 135, 6, 127, 0, 5, 0, 0, 0, 33, 6, 6, 0, 120, 6, 249, 255, 0, 4, 2, 0, 135, 3, 34, 0, 1, 4, 0, 0, 121, 3, 58, 0, 2, 6, 0, 0, 192, 3, 16, 0, 27, 5, 3, 120, 3, 6, 6, 5, 102, 6, 6, 14, 32, 6, 6, 70, 121, 6, 9, 0, 2, 6, 0, 0, 62, 4, 16, 0, 2, 5, 0, 0, 62, 4, 16, 0, 80, 5, 5, 0, 1, 7, 127, 255, 19, 5, 5, 7, 84, 6, 5, 0, 2, 5, 0, 0, 192, 3, 16, 0, 27, 6, 3, 120, 3, 5, 5, 6, 25, 2, 5, 11, 135, 5, 10, 0, 3, 0, 0, 0, 121, 5, 7, 0, 1, 6, 23, 0, 135, 5, 2, 0, 6, 0, 0, 0, 78, 6, 2, 0, 135, 5, 8, 0, 1, 4, 6, 0, 2, 5, 0, 0, 192, 3, 16, 0, 27, 6, 3, 120, 3, 4, 5, 6, 2, 5, 0, 0, 187, 200, 16, 0, 79, 5, 5, 0, 2, 7, 0, 0, 60, 4, 16, 0, 79, 7, 7, 0, 3, 5, 5, 7, 107, 4, 4, 5, 2, 6, 0, 0, 186, 200, 16, 0, 79, 6, 6, 0, 2, 7, 0, 0, 59, 4, 16, 0, 79, 7, 7, 0, 3, 6, 6, 7, 107, 4, 3, 6, 1, 6, 64, 0, 83, 2, 6, 0, 1, 5, 1, 0, 107, 4, 12, 5, 25, 4, 4, 6, 80, 5, 4, 0, 39, 5, 5, 4, 84, 4, 5, 0, 2, 5, 0, 0, 192, 3, 16, 0, 27, 6, 0, 120, 3, 5, 5, 6, 25, 0, 5, 116, 82, 4, 0, 0, 34, 6, 4, 1, 121, 6, 4, 0, 1, 6, 0, 0, 0, 5, 6, 0, 119, 0, 3, 0, 26, 6, 4, 1, 0, 5, 6, 0, 85, 0, 5, 0, 139, 0, 0, 0, 140, 0, 14, 0, 0, 0, 0, 0, 2, 6, 0, 0, 150, 0, 0, 0, 2, 7, 0, 0, 147, 0, 0, 0, 2, 8, 0, 0, 149, 0, 0, 0, 1, 4, 0, 0, 136, 9, 0, 0, 0, 5, 9, 0, 136, 9, 0, 0, 25, 9, 9, 16, 137, 9, 0, 0, 0, 3, 5, 0, 2, 9, 0, 0, 76, 200, 16, 0, 1, 10, 0, 0, 83, 9, 10, 0, 1, 9, 0, 0, 1, 11, 0, 0, 135, 10, 52, 0, 9, 11, 0, 0, 135, 10, 102, 0, 1, 1, 32, 0, 1, 10, 255, 0, 19, 10, 1, 10, 0, 2, 10, 0, 1, 11, 0, 0, 1, 9, 0, 0, 2, 12, 0, 0, 120, 138, 15, 0, 135, 10, 50, 0, 11, 9, 12, 0, 1, 12, 112, 0, 135, 10, 11, 0, 12, 0, 0, 0, 135, 10, 58, 0, 2, 0, 0, 0, 1, 12, 7, 0, 135, 10, 11, 0, 12, 0, 0, 0, 134, 0, 0, 0, 4, 229, 0, 0, 1, 12, 0, 0, 1, 9, 0, 0, 135, 10, 52, 0, 12, 9, 0, 0, 135, 10, 102, 0, 1, 10, 13, 0, 1, 9, 140, 0, 138, 0, 10, 9, 32, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 28, 189, 0, 0, 40, 189, 0, 0, 28, 189, 0, 0, 44, 189, 0, 0, 48, 189, 0, 0, 28, 189, 0, 0, 52, 189, 0, 0, 119, 0, 7, 0, 0, 0, 1, 0, 119, 0, 5, 0, 119, 0, 105, 0, 119, 0, 104, 0, 119, 0, 103, 0, 119, 0, 102, 0, 39, 10, 0, 32, 32, 10, 10, 121, 121, 10, 3, 0, 1, 4, 7, 0, 119, 0, 110, 0, 1, 10, 27, 0, 1, 9, 84, 0, 138, 0, 10, 9, 172, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 176, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 180, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 168, 190, 0, 0, 184, 190, 0, 0, 119, 0, 5, 0, 119, 0, 21, 0, 119, 0, 20, 0, 119, 0, 19, 0, 119, 0, 18, 0, 1, 9, 2, 0, 135, 10, 2, 0, 9, 0, 0, 0, 119, 0, 241, 254, 32, 9, 1, 32, 121, 9, 4, 0, 1, 9, 110, 0, 0, 10, 9, 0, 119, 0, 7, 0, 32, 12, 1, 110, 1, 11, 121, 0, 1, 13, 110, 0, 125, 9, 12, 11, 13, 0, 0, 0, 0, 10, 9, 0, 0, 1, 10, 0, 119, 0, 225, 254, 32, 10, 4, 7, 121, 10, 24, 0, 1, 9, 0, 0, 135, 10, 49, 0, 9, 0, 0, 0, 1, 9, 0, 0, 1, 13, 0, 0, 135, 10, 52, 0, 9, 13, 0, 0, 2, 10, 0, 0, 140, 200, 16, 0, 82, 10, 10, 0, 85, 3, 10, 0, 2, 13, 0, 0, 165, 138, 15, 0, 135, 10, 54, 0, 13, 3, 0, 0, 1, 13, 1, 0, 134, 10, 0, 0, 164, 109, 0, 0, 13, 0, 0, 0, 2, 10, 0, 0, 74, 200, 16, 0, 1, 13, 1, 0, 83, 10, 13, 0, 137, 5, 0, 0, 139, 0, 0, 0, 140, 0, 11, 0, 0, 0, 0, 0, 2, 6, 0, 0, 37, 50, 4, 0, 2, 7, 0, 0, 43, 50, 4, 0, 2, 8, 0, 0, 45, 50, 4, 0, 136, 9, 0, 0, 0, 4, 9, 0, 136, 9, 0, 0, 25, 9, 9, 32, 137, 9, 0, 0, 25, 3, 4, 16, 25, 2, 4, 8, 0, 0, 4, 0, 2, 9, 0, 0, 172, 200, 16, 0, 82, 1, 9, 0, 34, 9, 1, 1, 121, 9, 66, 0, 2, 9, 0, 0, 172, 200, 16, 0, 26, 10, 1, 1, 85, 9, 10, 0, 1, 10, 174, 252, 47, 10, 1, 10, 24, 192, 0, 0, 1, 9, 115, 0, 134, 10, 0, 0, 120, 137, 0, 0, 9, 0, 0, 0, 2, 10, 0, 0, 74, 200, 16, 0, 78, 10, 10, 0, 32, 10, 10, 0, 2, 9, 0, 0, 148, 200, 16, 0, 82, 9, 9, 0, 32, 9, 9, 0, 19, 10, 10, 9, 120, 10, 6, 0, 119, 0, 88, 0, 2, 10, 0, 0, 148, 200, 16, 0, 82, 10, 10, 0, 120, 10, 84, 0, 1, 9, 5, 0, 135, 10, 1, 0, 9, 0, 0, 0, 120, 10, 80, 0, 1, 9, 8, 0, 135, 10, 1, 0, 9, 0, 0, 0, 25, 3, 10, 4, 2, 10, 0, 0, 148, 200, 16, 0, 2, 9, 0, 0, 148, 200, 16, 0, 82, 9, 9, 0, 3, 9, 3, 9, 85, 10, 9, 0, 2, 9, 0, 0, 62, 4, 16, 0, 2, 10, 0, 0, 62, 4, 16, 0, 80, 10, 10, 0, 38, 10, 10, 251, 84, 9, 10, 0, 2, 10, 0, 0, 94, 200, 16, 0, 1, 9, 0, 0, 83, 10, 9, 0, 2, 9, 0, 0, 112, 200, 16, 0, 1, 10, 0, 0, 85, 9, 10, 0, 2, 10, 0, 0, 180, 200, 16, 0, 1, 9, 3, 0, 85, 10, 9, 0, 2, 10, 0, 0, 27, 122, 15, 0, 135, 9, 23, 0, 10, 0, 0, 0, 119, 0, 45, 0, 1, 9, 0, 0, 135, 5, 167, 0, 9, 0, 0, 0, 1, 9, 1, 0, 135, 0, 167, 0, 9, 0, 0, 0, 11, 9, 5, 0, 4, 9, 9, 0, 2, 10, 0, 0, 172, 200, 16, 0, 82, 10, 10, 0, 3, 0, 9, 10, 2, 10, 0, 0, 172, 200, 16, 0, 85, 10, 0, 0, 1, 10, 149, 0, 15, 10, 10, 1, 1, 9, 150, 0, 15, 9, 0, 9, 19, 10, 10, 9, 121, 10, 10, 0, 2, 10, 0, 0, 180, 200, 16, 0, 1, 9, 2, 0, 85, 10, 9, 0, 2, 10, 0, 0, 76, 122, 15, 0, 135, 9, 23, 0, 10, 2, 0, 0, 119, 0, 15, 0, 1, 9, 43, 1, 15, 9, 9, 1, 1, 10, 44, 1, 15, 10, 0, 10, 19, 9, 9, 10, 121, 9, 9, 0, 2, 9, 0, 0, 180, 200, 16, 0, 1, 10, 1, 0, 85, 9, 10, 0, 2, 9, 0, 0, 107, 122, 15, 0, 135, 10, 23, 0, 9, 3, 0, 0, 137, 4, 0, 0, 139, 0, 0, 0, 140, 0, 7, 0, 0, 0, 0, 0, 2, 1, 0, 0, 74, 200, 16, 0, 2, 2, 0, 0, 220, 211, 16, 0, 2, 3, 0, 0, 236, 210, 16, 0, 48, 4, 3, 2, 112, 194, 0, 0, 2, 0, 0, 0, 236, 210, 16, 0, 106, 4, 0, 8, 32, 4, 4, 255, 121, 4, 44, 0, 82, 4, 0, 0, 1, 5, 1, 0, 1, 6, 10, 0, 138, 4, 5, 6, 244, 193, 0, 0, 252, 193, 0, 0, 4, 194, 0, 0, 12, 194, 0, 0, 20, 194, 0, 0, 28, 194, 0, 0, 36, 194, 0, 0, 44, 194, 0, 0, 64, 194, 0, 0, 84, 194, 0, 0, 119, 0, 29, 0, 135, 5, 41, 0, 119, 0, 27, 0, 135, 5, 158, 0, 119, 0, 25, 0, 135, 5, 159, 0, 119, 0, 23, 0, 135, 5, 160, 0, 119, 0, 21, 0, 135, 5, 161, 0, 119, 0, 19, 0, 135, 5, 162, 0, 119, 0, 17, 0, 135, 5, 163, 0, 119, 0, 15, 0, 134, 5, 0, 0, 108, 191, 0, 0, 78, 5, 1, 0, 120, 5, 14, 0, 119, 0, 10, 0, 134, 5, 0, 0, 196, 151, 0, 0, 78, 5, 1, 0, 120, 5, 9, 0, 119, 0, 5, 0, 106, 6, 0, 4, 135, 5, 79, 0, 6, 0, 0, 0, 119, 0, 1, 0, 25, 0, 0, 12, 55, 4, 0, 2, 172, 193, 0, 0, 139, 0, 0, 0, 140, 0, 12, 0, 0, 0, 0, 0, 2, 4, 0, 0, 147, 0, 0, 0, 2, 5, 0, 0, 149, 0, 0, 0, 2, 6, 0, 0, 150, 0, 0, 0, 1, 3, 0, 0, 1, 8, 0, 0, 1, 9, 0, 0, 135, 7, 52, 0, 8, 9, 0, 0, 135, 7, 102, 0, 1, 1, 32, 0, 1, 7, 255, 0, 19, 7, 1, 7, 0, 2, 7, 0, 1, 9, 0, 0, 1, 8, 0, 0, 2, 10, 0, 0, 22, 130, 15, 0, 135, 7, 50, 0, 9, 8, 10, 0, 1, 10, 112, 0, 135, 7, 11, 0, 10, 0, 0, 0, 135, 7, 58, 0, 2, 0, 0, 0, 1, 10, 7, 0, 135, 7, 11, 0, 10, 0, 0, 0, 134, 0, 0, 0, 4, 229, 0, 0, 1, 10, 0, 0, 1, 8, 0, 0, 135, 7, 52, 0, 10, 8, 0, 0, 135, 7, 102, 0, 1, 7, 13, 0, 1, 8, 140, 0, 138, 0, 7, 8, 80, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 76, 197, 0, 0, 88, 197, 0, 0, 76, 197, 0, 0, 92, 197, 0, 0, 96, 197, 0, 0, 76, 197, 0, 0, 100, 197, 0, 0, 119, 0, 7, 0, 0, 0, 1, 0, 119, 0, 5, 0, 119, 0, 37, 0, 119, 0, 36, 0, 119, 0, 35, 0, 119, 0, 34, 0, 39, 7, 0, 32, 1, 8, 108, 0, 1, 10, 7, 0, 138, 7, 8, 10, 152, 197, 0, 0, 148, 197, 0, 0, 148, 197, 0, 0, 148, 197, 0, 0, 148, 197, 0, 0, 148, 197, 0, 0, 160, 197, 0, 0, 119, 0, 5, 0, 1, 3, 10, 0, 119, 0, 33, 0, 1, 0, 1, 0, 119, 0, 31, 0, 1, 7, 27, 0, 1, 8, 6, 0, 138, 0, 7, 8, 208, 197, 0, 0, 204, 197, 0, 0, 204, 197, 0, 0, 204, 197, 0, 0, 204, 197, 0, 0, 212, 197, 0, 0, 119, 0, 4, 0, 119, 0, 1, 0, 1, 3, 8, 0, 119, 0, 18, 0, 1, 8, 2, 0, 135, 7, 2, 0, 8, 0, 0, 0, 119, 0, 53, 255, 32, 8, 1, 32, 121, 8, 4, 0, 1, 8, 108, 0, 0, 7, 8, 0, 119, 0, 7, 0, 32, 10, 1, 108, 1, 9, 114, 0, 1, 11, 108, 0, 125, 8, 10, 9, 11, 0, 0, 0, 0, 7, 8, 0, 0, 1, 7, 0, 119, 0, 37, 255, 32, 7, 3, 8, 121, 7, 7, 0, 2, 7, 0, 0, 76, 200, 16, 0, 1, 8, 0, 0, 83, 7, 8, 0, 1, 0, 255, 255, 119, 0, 4, 0, 32, 8, 3, 10, 121, 8, 2, 0, 1, 0, 0, 0, 139, 0, 0, 0, 140, 0, 10, 0, 0, 0, 0, 0, 2, 2, 0, 0, 30, 50, 4, 0, 2, 3, 0, 0, 107, 255, 255, 255, 2, 4, 0, 0, 152, 0, 0, 0, 1, 1, 0, 0, 135, 5, 55, 0, 1, 6, 0, 0, 135, 5, 168, 0, 6, 0, 0, 0, 1, 6, 0, 0, 1, 7, 0, 0, 135, 5, 52, 0, 6, 7, 0, 0, 135, 5, 102, 0, 1, 0, 0, 0, 1, 7, 0, 0, 135, 5, 52, 0, 0, 7, 0, 0, 1, 7, 7, 0, 135, 5, 11, 0, 7, 0, 0, 0, 2, 7, 0, 0, 122, 113, 15, 0, 135, 5, 103, 0, 7, 0, 0, 0, 1, 7, 0, 0, 135, 5, 52, 0, 0, 7, 0, 0, 2, 6, 0, 0, 120, 200, 16, 0, 82, 6, 6, 0, 13, 6, 0, 6, 1, 8, 112, 0, 1, 9, 7, 0, 125, 7, 6, 8, 9, 0, 0, 0, 135, 5, 11, 0, 7, 0, 0, 0, 2, 7, 0, 0, 208, 225, 14, 0, 41, 9, 0, 3, 94, 7, 7, 9, 135, 5, 103, 0, 7, 0, 0, 0, 25, 0, 0, 1, 32, 5, 0, 23, 121, 5, 225, 255, 134, 0, 0, 0, 4, 229, 0, 0, 1, 5, 13, 0, 1, 7, 140, 0, 138, 0, 5, 7, 120, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0], eb + 40960);
    HEAPU8.set([96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 128, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 96, 201, 0, 0, 136, 201, 0, 0, 1, 5, 149, 0, 4, 5, 0, 5, 35, 5, 5, 2, 121, 5, 19, 0, 1, 0, 0, 0, 119, 0, 74, 255, 1, 1, 5, 0, 119, 0, 15, 0, 1, 0, 22, 0, 119, 0, 3, 0, 1, 0, 24, 0, 119, 0, 1, 0, 2, 5, 0, 0, 120, 200, 16, 0, 2, 7, 0, 0, 120, 200, 16, 0, 82, 7, 7, 0, 3, 7, 7, 0, 30, 7, 7, 23, 85, 5, 7, 0, 1, 0, 0, 0, 119, 0, 58, 255, 32, 7, 1, 5, 121, 7, 9, 0, 2, 7, 0, 0, 208, 225, 14, 0, 2, 5, 0, 0, 120, 200, 16, 0, 82, 5, 5, 0, 41, 5, 5, 3, 3, 7, 7, 5, 103, 0, 7, 4, 1, 5, 7, 0, 135, 7, 11, 0, 5, 0, 0, 0, 135, 7, 56, 0, 139, 0, 0, 0, 140, 2, 15, 0, 0, 0, 0, 0, 2, 8, 0, 0, 163, 49, 4, 0, 2, 9, 0, 0, 64, 2, 0, 0, 136, 10, 0, 0, 0, 6, 10, 0, 136, 10, 0, 0, 25, 10, 10, 16, 137, 10, 0, 0, 0, 5, 6, 0, 2, 10, 0, 0, 140, 198, 16, 0, 82, 2, 10, 0, 120, 1, 9, 0, 1, 11, 0, 0, 1, 12, 128, 255, 1, 13, 0, 0, 1, 14, 255, 255, 135, 10, 169, 0, 2, 11, 12, 13, 14, 0, 0, 0, 119, 0, 8, 0, 1, 14, 75, 0, 1, 13, 75, 0, 1, 12, 75, 0, 1, 11, 255, 255, 135, 10, 169, 0, 2, 14, 13, 12, 11, 0, 0, 0, 135, 3, 145, 0, 135, 10, 145, 0, 4, 1, 10, 3, 50, 10, 1, 9, 56, 203, 0, 0, 32, 4, 0, 0, 25, 2, 5, 12, 2, 11, 0, 0, 140, 198, 16, 0, 82, 11, 11, 0, 1, 12, 0, 0, 135, 10, 146, 0, 11, 12, 0, 0, 135, 10, 155, 0, 5, 0, 0, 0, 2, 12, 0, 0, 140, 198, 16, 0, 82, 12, 12, 0, 2, 11, 0, 0, 144, 198, 16, 0, 82, 11, 11, 0, 1, 13, 0, 0, 135, 10, 148, 0, 12, 11, 13, 5, 82, 13, 2, 0, 121, 4, 4, 0, 4, 12, 9, 1, 0, 11, 12, 0, 119, 0, 2, 0, 0, 11, 1, 0, 5, 10, 13, 11, 6, 7, 10, 9, 85, 2, 7, 0, 2, 11, 0, 0, 140, 198, 16, 0, 82, 11, 11, 0, 135, 10, 170, 0, 11, 5, 0, 0, 2, 11, 0, 0, 140, 198, 16, 0, 82, 11, 11, 0, 135, 10, 150, 0, 11, 0, 0, 0, 1, 11, 1, 0, 135, 10, 151, 0, 11, 0, 0, 0, 135, 10, 145, 0, 4, 1, 10, 3, 57, 10, 1, 9, 140, 202, 0, 0, 2, 10, 0, 0, 164, 198, 16, 0, 85, 10, 0, 0, 1, 11, 0, 0, 134, 10, 0, 0, 16, 165, 0, 0, 11, 0, 0, 0, 33, 10, 10, 0, 120, 10, 251, 255, 137, 6, 0, 0, 139, 0, 0, 0, 140, 0, 9, 0, 0, 0, 0, 0, 2, 2, 0, 0, 255, 0, 0, 0, 2, 3, 0, 0, 186, 200, 16, 0, 2, 4, 0, 0, 187, 200, 16, 0, 1, 1, 0, 0, 2, 5, 0, 0, 77, 200, 16, 0, 78, 5, 5, 0, 120, 5, 3, 0, 1, 1, 3, 0, 119, 0, 10, 0, 78, 5, 3, 0, 78, 6, 4, 0, 20, 5, 5, 6, 41, 5, 5, 24, 42, 5, 5, 24, 120, 5, 3, 0, 1, 1, 3, 0, 119, 0, 2, 0, 1, 0, 1, 0, 32, 5, 1, 3, 121, 5, 69, 0, 1, 6, 0, 0, 1, 7, 0, 0, 2, 8, 0, 0, 124, 124, 15, 0, 135, 5, 50, 0, 6, 7, 8, 0, 1, 8, 112, 0, 135, 5, 11, 0, 8, 0, 0, 0, 1, 8, 32, 0, 135, 5, 58, 0, 8, 0, 0, 0, 1, 8, 7, 0, 135, 5, 11, 0, 8, 0, 0, 0, 134, 0, 0, 0, 4, 229, 0, 0, 33, 5, 0, 27, 121, 5, 48, 0, 19, 8, 0, 2, 135, 5, 45, 0, 8, 3, 0, 0, 120, 5, 9, 0, 1, 8, 2, 0, 135, 5, 2, 0, 8, 0, 0, 0, 134, 0, 0, 0, 4, 229, 0, 0, 32, 5, 0, 27, 121, 5, 246, 255, 119, 0, 36, 0, 135, 5, 18, 0, 2, 5, 0, 0, 62, 4, 16, 0, 80, 5, 5, 0, 1, 8, 0, 1, 19, 5, 5, 8, 120, 5, 3, 0, 1, 0, 1, 0, 119, 0, 29, 0, 1, 8, 5, 0, 135, 5, 1, 0, 8, 0, 0, 0, 121, 5, 3, 0, 1, 0, 1, 0, 119, 0, 23, 0, 1, 8, 3, 0, 135, 5, 1, 0, 8, 0, 0, 0, 3, 5, 5, 2, 19, 5, 5, 2, 0, 1, 5, 0, 83, 4, 1, 0, 1, 8, 3, 0, 135, 5, 1, 0, 8, 0, 0, 0, 3, 1, 5, 2, 83, 3, 1, 0, 78, 5, 4, 0, 32, 5, 5, 0, 19, 8, 1, 2, 32, 8, 8, 0, 19, 5, 5, 8, 120, 5, 239, 255, 1, 0, 1, 0, 119, 0, 3, 0, 135, 5, 18, 0, 1, 0, 0, 0, 139, 0, 0, 0, 140, 1, 10, 0, 0, 0, 0, 0, 136, 8, 0, 0, 0, 6, 8, 0, 136, 8, 0, 0, 25, 8, 8, 16, 137, 8, 0, 0, 0, 5, 6, 0, 134, 8, 0, 0, 100, 203, 0, 0, 120, 8, 6, 0, 2, 8, 0, 0, 76, 200, 16, 0, 1, 9, 0, 0, 83, 8, 9, 0, 119, 0, 68, 0, 2, 9, 0, 0, 60, 4, 16, 0, 78, 1, 9, 0, 2, 9, 0, 0, 59, 4, 16, 0, 78, 3, 9, 0, 135, 8, 33, 0, 1, 3, 0, 0, 135, 9, 127, 0, 8, 0, 0, 0, 121, 9, 15, 0, 2, 9, 0, 0, 187, 200, 16, 0, 78, 2, 9, 0, 2, 9, 0, 0, 186, 200, 16, 0, 78, 4, 9, 0, 3, 1, 1, 2, 3, 3, 3, 4, 135, 8, 33, 0, 1, 3, 0, 0, 135, 9, 127, 0, 8, 0, 0, 0, 33, 9, 9, 0, 120, 9, 249, 255, 135, 2, 34, 0, 1, 3, 0, 0, 121, 2, 26, 0, 2, 9, 0, 0, 192, 3, 16, 0, 27, 8, 2, 120, 3, 4, 9, 8, 25, 2, 4, 6, 81, 7, 2, 0, 1, 9, 0, 32, 19, 9, 7, 9, 32, 9, 9, 0, 121, 9, 5, 0, 1, 9, 0, 16, 20, 9, 7, 9, 0, 8, 9, 0, 119, 0, 5, 0, 2, 9, 0, 0, 255, 223, 0, 0, 19, 9, 7, 9, 0, 8, 9, 0, 84, 2, 8, 0, 1, 9, 1, 0, 107, 4, 9, 9, 107, 5, 1, 1, 83, 5, 3, 0, 135, 9, 36, 0, 5, 0, 0, 0, 2, 9, 0, 0, 192, 3, 16, 0, 27, 8, 0, 120, 3, 9, 9, 8, 25, 7, 9, 116, 82, 5, 7, 0, 34, 8, 5, 1, 121, 8, 4, 0, 1, 8, 0, 0, 0, 9, 8, 0, 119, 0, 3, 0, 26, 8, 5, 1, 0, 9, 8, 0, 85, 7, 9, 0, 137, 6, 0, 0, 139, 0, 0, 0, 140, 0, 15, 0, 0, 0, 0, 0, 2, 7, 0, 0, 128, 61, 16, 0, 2, 8, 0, 0, 160, 54, 16, 0, 2, 9, 0, 0, 255, 0, 0, 0, 136, 10, 0, 0, 0, 6, 10, 0, 136, 10, 0, 0, 25, 10, 10, 16, 137, 10, 0, 0, 0, 5, 6, 0, 135, 10, 55, 0, 1, 11, 0, 0, 135, 10, 49, 0, 11, 0, 0, 0, 1, 1, 1, 0, 26, 3, 1, 1, 1, 2, 0, 0, 27, 10, 2, 22, 3, 0, 3, 10, 90, 4, 7, 0, 41, 10, 4, 24, 42, 10, 10, 24, 32, 10, 10, 240, 121, 10, 3, 0, 1, 0, 32, 0, 119, 0, 8, 0, 90, 10, 8, 0, 38, 10, 10, 16, 32, 10, 10, 0, 1, 11, 13, 0, 1, 12, 7, 0, 125, 0, 10, 11, 12, 0, 0, 0, 19, 11, 4, 9, 135, 12, 121, 0, 11, 0, 2, 1, 25, 2, 2, 1, 33, 12, 2, 80, 120, 12, 235, 255, 25, 1, 1, 1, 33, 12, 1, 23, 120, 12, 230, 255, 1, 11, 1, 0, 1, 10, 14, 0, 2, 13, 0, 0, 59, 4, 16, 0, 78, 13, 13, 0, 2, 14, 0, 0, 60, 4, 16, 0, 78, 14, 14, 0, 135, 12, 121, 0, 11, 10, 13, 14, 1, 14, 0, 0, 1, 13, 0, 0, 135, 12, 52, 0, 14, 13, 0, 0, 2, 12, 0, 0, 136, 200, 16, 0, 82, 12, 12, 0, 85, 5, 12, 0, 2, 13, 0, 0, 148, 123, 15, 0, 135, 12, 54, 0, 13, 5, 0, 0, 1, 13, 23, 0, 1, 14, 0, 0, 2, 10, 0, 0, 96, 113, 15, 0, 135, 12, 50, 0, 13, 14, 10, 0, 134, 12, 0, 0, 4, 229, 0, 0, 1, 10, 13, 0, 1, 14, 20, 0, 138, 12, 10, 14, 196, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 200, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 192, 207, 0, 0, 204, 207, 0, 0, 119, 0, 4, 0, 119, 0, 7, 0, 119, 0, 6, 0, 119, 0, 5, 0, 1, 10, 2, 0, 135, 12, 2, 0, 10, 0, 0, 0, 119, 0, 224, 255, 135, 12, 56, 0, 137, 6, 0, 0, 139, 0, 0, 0, 140, 1, 12, 0, 0, 0, 0, 0, 136, 8, 0, 0, 0, 3, 8, 0, 136, 8, 0, 0, 25, 8, 8, 16, 137, 8, 0, 0, 0, 1, 3, 0, 134, 8, 0, 0, 100, 203, 0, 0, 120, 8, 6, 0, 2, 8, 0, 0, 76, 200, 16, 0, 1, 9, 0, 0, 83, 8, 9, 0, 119, 0, 69, 0, 2, 9, 0, 0, 187, 200, 16, 0, 79, 9, 9, 0, 2, 8, 0, 0, 60, 4, 16, 0, 79, 8, 8, 0, 3, 4, 9, 8, 107, 1, 1, 4, 2, 8, 0, 0, 186, 200, 16, 0, 79, 8, 8, 0, 2, 9, 0, 0, 59, 4, 16, 0, 79, 9, 9, 0, 3, 2, 8, 9, 83, 1, 2, 0, 41, 9, 4, 24, 42, 9, 9, 24, 41, 8, 2, 24, 42, 8, 8, 24, 135, 2, 34, 0, 9, 8, 0, 0, 121, 2, 32, 0, 1, 9, 20, 0, 135, 8, 1, 0, 9, 0, 0, 0, 32, 5, 8, 0, 2, 8, 0, 0, 192, 3, 16, 0, 27, 9, 0, 120, 3, 4, 8, 9, 25, 6, 4, 82, 2, 9, 0, 0, 51, 100, 56, 0, 2, 8, 0, 0, 50, 100, 56, 0, 125, 7, 5, 9, 8, 0, 0, 0, 84, 6, 7, 0, 43, 9, 7, 16, 108, 6, 2, 9, 1, 10, 9, 0, 1, 11, 4, 0, 125, 8, 5, 10, 11, 0, 0, 0, 109, 4, 108, 8, 2, 9, 0, 0, 192, 3, 16, 0, 27, 11, 2, 120, 3, 9, 9, 11, 102, 9, 9, 14, 1, 11, 0, 0, 135, 8, 66, 0, 1, 9, 0, 11, 2, 8, 0, 0, 192, 3, 16, 0, 27, 11, 0, 120, 3, 8, 8, 11, 25, 7, 8, 116, 82, 6, 7, 0, 34, 11, 6, 1, 121, 11, 4, 0, 1, 11, 0, 0, 0, 8, 11, 0, 119, 0, 3, 0, 26, 11, 6, 1, 0, 8, 11, 0, 85, 7, 8, 0, 137, 3, 0, 0, 139, 0, 0, 0, 140, 1, 9, 0, 0, 0, 0, 0, 136, 7, 0, 0, 0, 6, 7, 0, 136, 7, 0, 0, 25, 7, 7, 16, 137, 7, 0, 0, 0, 5, 6, 0, 134, 7, 0, 0, 100, 203, 0, 0, 120, 7, 6, 0, 2, 7, 0, 0, 76, 200, 16, 0, 1, 8, 0, 0, 83, 7, 8, 0, 119, 0, 66, 0, 2, 8, 0, 0, 60, 4, 16, 0, 78, 1, 8, 0, 2, 8, 0, 0, 59, 4, 16, 0, 78, 3, 8, 0, 135, 7, 33, 0, 1, 3, 0, 0, 135, 8, 127, 0, 7, 0, 0, 0, 121, 8, 15, 0, 2, 8, 0, 0, 187, 200, 16, 0, 78, 2, 8, 0, 2, 8, 0, 0, 186, 200, 16, 0, 78, 4, 8, 0, 3, 1, 1, 2, 3, 3, 3, 4, 135, 7, 33, 0, 1, 3, 0, 0, 135, 8, 127, 0, 7, 0, 0, 0, 33, 8, 8, 0, 120, 8, 249, 255, 135, 2, 34, 0, 1, 3, 0, 0, 121, 2, 24, 0, 2, 8, 0, 0, 192, 3, 16, 0, 27, 7, 2, 120, 3, 8, 8, 7, 25, 4, 8, 6, 81, 2, 4, 0, 1, 7, 0, 16, 19, 7, 2, 7, 32, 7, 7, 0, 121, 7, 5, 0, 1, 7, 0, 32, 20, 7, 2, 7, 0, 8, 7, 0, 119, 0, 5, 0, 2, 7, 0, 0, 255, 239, 0, 0, 19, 7, 2, 7, 0, 8, 7, 0, 84, 4, 8, 0, 107, 5, 1, 1, 83, 5, 3, 0, 135, 8, 36, 0, 5, 0, 0, 0, 2, 8, 0, 0, 192, 3, 16, 0, 27, 7, 0, 120, 3, 8, 8, 7, 25, 5, 8, 116, 82, 0, 5, 0, 34, 7, 0, 1, 121, 7, 4, 0, 1, 7, 0, 0, 0, 8, 7, 0, 119, 0, 3, 0, 26, 7, 0, 1, 0, 8, 7, 0, 85, 5, 8, 0, 137, 6, 0, 0, 139, 0, 0, 0, 140, 1, 8, 0, 0, 0, 0, 0, 134, 5, 0, 0, 100, 203, 0, 0, 120, 5, 6, 0, 2, 5, 0, 0, 76, 200, 16, 0, 1, 6, 0, 0, 83, 5, 6, 0, 119, 0, 75, 0, 2, 6, 0, 0, 60, 4, 16, 0, 78, 1, 6, 0, 2, 6, 0, 0, 59, 4, 16, 0, 78, 2, 6, 0, 135, 5, 33, 0, 1, 2, 0, 0, 135, 6, 127, 0, 5, 0, 0, 0, 121, 6, 15, 0, 2, 6, 0, 0, 187, 200, 16, 0, 78, 3, 6, 0, 2, 6, 0, 0, 186, 200, 16, 0, 78, 4, 6, 0, 3, 1, 1, 3, 3, 2, 2, 4, 135, 5, 33, 0, 1, 2, 0, 0, 135, 6, 127, 0, 5, 0, 0, 0, 33, 6, 6, 0, 120, 6, 249, 255, 135, 1, 34, 0, 1, 2, 0, 0, 121, 1, 33, 0, 2, 6, 0, 0, 192, 3, 16, 0, 27, 5, 1, 120, 3, 6, 6, 5, 102, 2, 6, 14, 41, 6, 2, 24, 42, 6, 6, 24, 32, 6, 6, 70, 121, 6, 9, 0, 2, 6, 0, 0, 62, 4, 16, 0, 2, 5, 0, 0, 62, 4, 16, 0, 80, 5, 5, 0, 1, 7, 127, 255, 19, 5, 5, 7, 84, 6, 5, 0, 2, 5, 0, 0, 192, 3, 16, 0, 27, 6, 1, 120, 3, 1, 5, 6, 25, 4, 1, 6, 80, 6, 4, 0, 1, 5, 235, 245, 19, 6, 6, 5, 0, 3, 6, 0, 107, 1, 10, 2, 1, 5, 1, 0, 107, 1, 12, 5, 1, 5, 4, 8, 20, 5, 3, 5, 84, 4, 5, 0, 2, 5, 0, 0, 192, 3, 16, 0, 27, 6, 0, 120, 3, 5, 5, 6, 25, 0, 5, 116, 82, 4, 0, 0, 34, 6, 4, 1, 121, 6, 4, 0, 1, 6, 0, 0, 0, 5, 6, 0, 119, 0, 3, 0, 26, 6, 4, 1, 0, 5, 6, 0, 85, 0, 5, 0, 139, 0, 0, 0, 140, 0, 9, 0, 0, 0, 0, 0, 2, 6, 0, 0, 76, 200, 16, 0, 136, 7, 0, 0, 0, 4, 7, 0, 136, 7, 0, 0, 25, 7, 7, 32, 137, 7, 0, 0, 25, 3, 4, 16, 25, 2, 4, 8, 2, 7, 0, 0, 99, 200, 16, 0, 78, 5, 7, 0, 41, 7, 5, 24, 42, 7, 7, 24, 32, 0, 7, 0, 2, 7, 0, 0, 100, 200, 16, 0, 78, 1, 7, 0, 20, 7, 1, 5, 41, 7, 7, 24, 42, 7, 7, 24, 120, 7, 8, 0, 2, 8, 0, 0, 166, 129, 15, 0, 135, 7, 23, 0, 8, 4, 0, 0, 1, 7, 0, 0, 83, 6, 7, 0, 119, 0, 54, 0, 41, 7, 1, 24, 42, 7, 7, 24, 32, 7, 7, 0, 20, 7, 0, 7, 121, 7, 4, 0, 38, 7, 0, 1, 0, 0, 7, 0, 119, 0, 5, 0, 134, 0, 0, 0, 116, 194, 0, 0, 34, 7, 0, 0, 120, 7, 42, 0, 2, 7, 0, 0, 99, 200, 16, 0, 90, 5, 7, 0, 1, 7, 255, 0, 19, 7, 5, 7, 0, 1, 7, 0, 41, 7, 5, 24, 42, 7, 7, 24, 120, 7, 8, 0, 2, 8, 0, 0, 196, 129, 15, 0, 135, 7, 23, 0, 8, 2, 0, 0, 1, 7, 0, 0, 83, 6, 7, 0, 119, 0, 26, 0, 135, 0, 53, 0, 1, 0, 0, 0, 134, 5, 0, 0, 24, 175, 0, 0, 1, 0, 0, 0, 32, 7, 5, 0, 2, 8, 0, 0, 74, 200, 16, 0, 78, 8, 8, 0, 33, 8, 8, 0, 20, 7, 7, 8, 120, 7, 14, 0, 1, 8, 1, 0, 135, 7, 28, 0, 1, 8, 0, 0, 2, 7, 0, 0, 242, 200, 16, 0, 85, 3, 7, 0, 41, 8, 0, 24, 42, 8, 8, 24, 109, 3, 4, 8, 2, 7, 0, 0, 221, 129, 15, 0, 135, 8, 23, 0, 7, 3, 0, 0, 137, 4, 0, 0, 139, 0, 0, 0, 140, 2, 12, 0, 0, 0, 0, 0, 2, 6, 0, 0, 255, 0, 0, 0, 2, 7, 0, 0, 27, 50, 4, 0, 2, 8, 0, 0, 78, 200, 16, 0, 1, 4, 0, 0, 136, 9, 0, 0, 0, 5, 9, 0, 136, 9, 0, 0, 25, 9, 9, 16, 137, 9, 0, 0, 2, 9, 0, 0, 64, 4, 16, 0, 78, 9, 9, 0, 120, 9, 7, 0, 2, 10, 0, 0, 69, 126, 15, 0, 135, 9, 23, 0, 10, 5, 0, 0, 1, 2, 0, 0, 119, 0, 92, 0, 78, 2, 8, 0, 2, 9, 0, 0, 108, 200, 16, 0, 82, 3, 9, 0, 2, 9, 0, 0, 77, 200, 16, 0, 78, 9, 9, 0, 33, 9, 9, 0, 41, 10, 2, 24, 42, 10, 10, 24, 33, 10, 10, 0, 19, 9, 9, 10, 33, 10, 3, 0, 19, 9, 9, 10, 121, 9, 9, 0, 135, 9, 171, 0, 2, 0, 0, 0, 45, 9, 3, 9, 248, 213, 0, 0, 2, 9, 0, 0, 108, 200, 16, 0, 82, 2, 9, 0, 119, 0, 69, 0, 134, 9, 0, 0, 156, 126, 0, 0, 1, 0, 0, 0, 19, 9, 9, 6, 0, 3, 9, 0, 41, 9, 3, 24, 42, 9, 9, 24, 1, 10, 0, 0, 1, 11, 33, 0, 138, 9, 10, 11, 168, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 176, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 164, 214, 0, 0, 180, 214, 0, 0, 119, 0, 5, 0, 1, 4, 8, 0, 119, 0, 6, 0, 119, 0, 254, 255, 119, 0, 253, 255, 135, 2, 171, 0, 3, 0, 0, 0, 121, 2, 206, 255, 32, 9, 4, 8, 121, 9, 7, 0, 2, 9, 0, 0, 76, 200, 16, 0, 1, 10, 0, 0, 83, 9, 10, 0, 1, 2, 0, 0, 119, 0, 10, 0, 83, 8, 3, 0, 2, 9, 0, 0, 39, 102, 15, 0, 135, 10, 32, 0, 0, 9, 0, 0, 121, 10, 4, 0, 2, 10, 0, 0, 108, 200, 16, 0, 85, 10, 2, 0, 137, 5, 0, 0, 139, 2, 0, 0, 140, 0, 9, 0, 0, 0, 0, 0, 2, 5, 0, 0, 76, 200, 16, 0, 2, 6, 0, 0, 98, 200, 16, 0, 136, 7, 0, 0, 0, 4, 7, 0, 136, 7, 0, 0, 25, 7, 7, 16, 137, 7, 0, 0, 25, 3, 4, 8, 0, 2, 4, 0, 78, 0, 6, 0, 1, 7, 255, 0, 19, 7, 0, 7, 134, 1, 0, 0, 24, 175, 0, 0, 7, 0, 0, 0, 2, 7, 0, 0, 74, 200, 16, 0, 78, 7, 7, 0, 120, 7, 51, 0, 83, 6, 0, 0, 121, 1, 49, 0, 2, 7, 0, 0, 99, 131, 15, 0, 1, 8, 24, 0, 134, 0, 0, 0, 60, 213, 0, 0, 7, 8, 0, 0, 120, 0, 4, 0, 1, 8, 0, 0, 83, 5, 8, 0, 119, 0, 39, 0, 2, 8, 0, 0, 192, 3, 16, 0, 27, 7, 0, 120, 3, 8, 8, 7, 102, 8, 8, 77, 32, 8, 8, 8, 121, 8, 8, 0, 2, 7, 0, 0, 105, 131, 15, 0, 135, 8, 23, 0, 7, 2, 0, 0, 1, 8, 0, 0, 83, 5, 8, 0, 119, 0, 25, 0, 135, 8, 126, 0, 0, 0, 0, 0, 120, 8, 19, 0, 1, 7, 20, 0, 135, 8, 2, 0, 7, 0, 0, 0, 1, 7, 1, 0, 135, 8, 28, 0, 0, 7, 0, 0, 83, 6, 0, 0, 135, 2, 53, 0, 0, 0, 0, 0, 2, 8, 0, 0, 242, 200, 16, 0, 85, 3, 8, 0, 109, 3, 4, 2, 2, 7, 0, 0, 128, 131, 15, 0, 135, 8, 23, 0, 7, 3, 0, 0, 119, 0, 4, 0, 1, 8, 0, 0, 83, 5, 8, 0, 119, 0, 1, 0, 137, 4, 0, 0, 139, 0, 0, 0, 140, 1, 7, 0, 0, 0, 0, 0, 136, 5, 0, 0, 0, 4, 5, 0, 136, 5, 0, 0, 25, 5, 5, 32, 137, 5, 0, 0, 25, 3, 4, 16, 25, 2, 4, 8, 0, 1, 4, 0, 2, 5, 0, 0, 19, 204, 16, 0, 78, 5, 5, 0, 120, 5, 10, 0, 134, 5, 0, 0, 100, 203, 0, 0, 120, 5, 7, 0, 2, 5, 0, 0, 76, 200, 16, 0, 1, 6, 0, 0, 83, 5, 6, 0, 137, 4, 0, 0, 139, 0, 0, 0, 2, 6, 0, 0, 62, 4, 16, 0, 80, 6, 6, 0, 38, 6, 6, 1, 120, 6, 24, 0, 2, 6, 0, 0, 19, 204, 16, 0, 1, 5, 1, 0, 83, 6, 5, 0, 2, 5, 0, 0, 160, 50, 16, 0, 2, 6, 0, 0, 69, 4, 16, 0, 79, 6, 6, 0, 27, 6, 6, 44, 90, 5, 5, 6, 38, 5, 5, 2, 120, 5, 6, 0, 2, 6, 0, 0, 25, 126, 15, 0, 135, 5, 23, 0, 6, 3, 0, 0, 119, 0, 10, 0, 2, 6, 0, 0, 246, 125, 15, 0, 135, 5, 23, 0, 6, 2, 0, 0, 119, 0, 5, 0, 2, 6, 0, 0, 213, 125, 15, 0, 135, 5, 23, 0, 6, 1, 0, 0, 2, 5, 0, 0, 160, 50, 16, 0, 2, 6, 0, 0, 69, 4, 16, 0, 79, 6, 6, 0, 27, 6, 6, 44, 3, 1, 5, 6, 79, 2, 1, 0, 38, 6, 2, 2, 120, 6, 8, 0, 1, 6, 254, 0, 19, 6, 2, 6, 83, 1, 6, 0, 2, 5, 0, 0, 59, 4, 16, 0, 135, 6, 63, 0, 5, 0, 0, 0, 2, 6, 0, 0, 192, 3, 16, 0, 27, 5, 0, 120, 3, 6, 6, 5, 25, 0, 6, 116, 82, 3, 0, 0, 34, 5, 3, 1, 121, 5, 4, 0, 1, 5, 0, 0, 0, 6, 5, 0, 119, 0, 3, 0, 26, 5, 3, 1, 0, 6, 5, 0, 85, 0, 6, 0, 137, 4, 0, 0, 139, 0, 0, 0, 140, 0, 9, 0, 0, 0, 0, 0, 2, 4, 0, 0, 97, 200, 16, 0, 2, 5, 0, 0, 192, 3, 16, 0, 2, 6, 0, 0, 74, 200, 16, 0, 136, 7, 0, 0, 0, 3, 7, 0, 136, 7, 0, 0, 25, 7, 7, 32, 137, 7, 0, 0, 25, 2, 3, 16, 25, 1, 3, 8, 0, 0, 3, 0, 78, 7, 4, 0, 120, 7, 47, 0, 2, 7, 0, 0, 49, 131, 15, 0, 1, 8, 8, 0, 134, 0, 0, 0, 60, 213, 0, 0, 7, 8, 0, 0, 121, 0, 48, 0, 27, 8, 0, 120, 3, 8, 5, 8, 102, 8, 8, 77, 33, 8, 8, 8, 121, 8, 6, 0, 2, 7, 0, 0, 54, 131, 15, 0, 135, 8, 23, 0, 7, 1, 0, 0, 119, 0, 38, 0, 1, 7, 0, 0, 135, 8, 2, 0, 7, 0, 0, 0, 134, 8, 0, 0, 124, 193, 0, 0, 78, 8, 6, 0, 120, 8, 31, 0, 134, 8, 0, 0, 0, 174, 0, 0, 78, 8, 6, 0, 120, 8, 27, 0, 27, 8, 0, 120, 3, 8, 5, 8, 25, 1, 8, 76, 78, 8, 1, 0, 39, 8, 8, 2, 83, 1, 8, 0, 1, 7, 1, 0, 135, 8, 28, 0, 0, 7, 0, 0, 83, 4, 0, 0, 2, 8, 0, 0, 242, 200, 16, 0, 85, 2, 8, 0, 2, 7, 0, 0, 75, 131, 15, 0, 135, 8, 23, 0, 7, 2, 0, 0, 119, 0, 9, 0, 2, 7, 0, 0, 241, 130, 15, 0, 135, 8, 23, 0, 7, 0, 0, 0, 2, 8, 0, 0, 76, 200, 16, 0, 1, 7, 0, 0, 83, 8, 7, 0, 137, 3, 0, 0, 139, 0, 0, 0, 140, 0, 8, 0, 0, 0, 0, 0, 2, 4, 0, 0, 34, 50, 4, 0, 136, 5, 0, 0, 0, 3, 5, 0, 136, 5, 0, 0, 25, 5, 5, 32, 137, 5, 0, 0, 25, 2, 3, 16, 25, 1, 3, 8, 0, 0, 3, 0, 2, 5, 0, 0, 76, 200, 16, 0, 1, 6, 0, 0, 83, 5, 6, 0, 2, 6, 0, 0, 128, 61, 16, 0, 2, 5, 0, 0, 60, 4, 16, 0, 78, 5, 5, 0, 26, 5, 5, 1, 2, 7, 0, 0, 59, 4, 16, 0, 78, 7, 7, 0, 27, 7, 7, 22, 3, 5, 5, 7, 90, 6, 6, 5, 32, 6, 6, 240, 121, 6, 34, 0, 2, 6, 0, 0, 89, 200, 16, 0, 78, 6, 6, 0, 120, 6, 6, 0, 2, 5, 0, 0, 143, 126, 15, 0, 135, 6, 23, 0, 5, 1, 0, 0, 119, 0, 29, 0, 1, 5, 22, 0, 135, 6, 2, 0, 5, 0, 0, 0, 2, 6, 0, 0, 136, 200, 16, 0, 82, 6, 6, 0, 26, 2, 6, 1, 2, 6, 0, 0, 136, 200, 16, 0, 85, 6, 2, 0, 120, 2, 7, 0, 134, 6, 0, 0, 0, 53, 0, 0, 2, 6, 0, 0, 74, 200, 16, 0, 78, 6, 6, 0, 120, 6, 12, 0, 134, 6, 0, 0, 12, 99, 0, 0, 2, 5, 0, 0, 99, 126, 15, 0, 135, 6, 23, 0, 5, 0, 0, 0, 119, 0, 5, 0, 2, 5, 0, 0, 174, 126, 15, 0, 135, 6, 23, 0, 5, 2, 0, 0, 137, 3, 0, 0, 139, 0, 0, 0, 140, 0, 7, 0, 0, 0, 0, 0, 136, 4, 0, 0, 0, 3, 4, 0, 136, 4, 0, 0, 25, 4, 4, 16, 137, 4, 0, 0, 25, 2, 3, 8, 0, 1, 3, 0, 2, 4, 0, 0, 76, 200, 16, 0, 1, 5, 0, 0, 83, 4, 5, 0, 134, 5, 0, 0, 100, 203, 0, 0, 121, 5, 44, 0, 2, 5, 0, 0, 187, 200, 16, 0, 79, 5, 5, 0, 2, 4, 0, 0, 60, 4, 16, 0, 79, 4, 4, 0, 3, 5, 5, 4, 41, 5, 5, 24, 42, 5, 5, 24, 26, 5, 5, 1, 2, 4, 0, 0, 186, 200, 16, 0, 79, 4, 4, 0, 2, 6, 0, 0, 59, 4, 16, 0, 79, 6, 6, 0, 3, 4, 4, 6, 41, 4, 4, 24, 42, 4, 4, 24, 27, 4, 4, 22, 3, 0, 5, 4, 2, 4, 0, 0, 128, 61, 16, 0, 90, 4, 4, 0, 32, 4, 4, 4, 121, 4, 13, 0, 2, 4, 0, 0, 160, 54, 16, 0, 90, 4, 4, 0, 38, 4, 4, 7, 135, 1, 172, 0, 4, 0, 0, 0, 85, 2, 1, 0, 2, 5, 0, 0, 4, 114, 15, 0, 135, 4, 23, 0, 5, 2, 0, 0, 119, 0, 6, 0, 2, 5, 0, 0, 109, 124, 15, 0, 135, 4, 23, 0, 5, 1, 0, 0, 119, 0, 1, 0, 137, 3, 0, 0, 139, 0, 0, 0, 140, 1, 5, 0, 0, 0, 0, 0, 27, 0, 0, 30, 2, 3, 0, 0, 204, 221, 16, 0, 82, 3, 3, 0, 120, 3, 5, 0, 135, 1, 173, 0, 2, 3, 0, 0, 204, 221, 16, 0, 85, 3, 1, 0, 135, 3, 51, 0, 135, 1, 173, 0, 2, 3, 0, 0, 204, 221, 16, 0, 82, 3, 3, 0, 4, 3, 1, 3, 48, 3, 3, 0, 108, 221, 0, 0, 1, 3, 0, 0, 134, 1, 0, 0, 16, 165, 0, 0, 3, 0, 0, 0, 135, 2, 173, 0, 32, 4, 1, 0, 121, 4, 8, 0, 2, 4, 0, 0, 204, 221, 16, 0, 82, 4, 4, 0, 4, 4, 2, 4, 16, 4, 4, 0, 0, 3, 4, 0, 119, 0, 3, 0, 1, 4, 0, 0, 0, 3, 4, 0, 120, 3, 240, 255, 32, 3, 1, 27, 38, 3, 3, 1, 0, 0, 3, 0, 119, 0, 2, 0, 1, 0, 0, 0, 135, 3, 101, 0, 135, 2, 173, 0, 2, 3, 0, 0, 204, 221, 16, 0, 85, 3, 2, 0, 139, 0, 0, 0, 140, 0, 6, 0, 0, 0, 0, 0, 136, 4, 0, 0, 0, 2, 4, 0, 136, 4, 0, 0, 25, 4, 4, 16, 137, 4, 0, 0, 25, 1, 2, 8, 2, 4, 0, 0, 97, 200, 16, 0, 78, 3, 4, 0, 1, 4, 255, 0, 19, 4, 3, 4, 0, 0, 4, 0, 41, 4, 3, 24, 42, 4, 4, 24, 120, 4, 10, 0, 2, 4, 0, 0, 76, 200, 16, 0, 1, 5, 0, 0, 83, 4, 5, 0, 2, 4, 0, 0, 180, 130, 15, 0, 135, 5, 23, 0, 4, 2, 0, 0, 119, 0, 28, 0, 134, 3, 0, 0, 24, 175, 0, 0, 0, 0, 0, 0, 32, 5, 3, 0, 2, 4, 0, 0, 74, 200, 16, 0, 78, 4, 4, 0, 33, 4, 4, 0, 20, 5, 5, 4, 120, 5, 18, 0, 2, 5, 0, 0, 97, 200, 16, 0, 1, 4, 0, 0, 83, 5, 4, 0, 135, 3, 53, 0, 0, 0, 0, 0, 1, 5, 1, 0, 135, 4, 28, 0, 0, 5, 0, 0, 85, 1, 3, 0, 2, 5, 0, 0, 242, 200, 16, 0, 109, 1, 4, 5, 2, 4, 0, 0, 210, 130, 15, 0, 135, 5, 23, 0, 4, 1, 0, 0, 137, 2, 0, 0, 139, 0, 0, 0, 140, 0, 6, 0, 0, 0, 0, 0, 2, 2, 0, 0, 76, 200, 16, 0, 1, 3, 0, 0, 83, 2, 3, 0, 135, 3, 55, 0, 1, 2, 0, 0, 135, 3, 49, 0, 2, 0, 0, 0, 2, 3, 0, 0, 0, 246, 14, 0, 82, 0, 3, 0, 121, 0, 12, 0, 1, 1, 0, 0, 1, 2, 0, 0, 135, 3, 50, 0, 1, 2, 0, 0, 25, 1, 1, 1, 2, 3, 0, 0, 0, 246, 14, 0, 41, 2, 1, 2, 94, 0, 3, 2, 33, 3, 0, 0, 120, 3, 247, 255, 1, 2, 23, 0, 1, 4, 0, 0, 2, 5, 0, 0, 96, 113, 15, 0, 135, 3, 50, 0, 2, 4, 5, 0, 134, 3, 0, 0, 4, 229, 0, 0, 1, 5, 13, 0, 1, 4, 20, 0, 138, 3, 5, 4, 72, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 76, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 68, 223, 0, 0, 80, 223, 0, 0, 119, 0, 4, 0, 119, 0, 7, 0, 119, 0, 6, 0, 119, 0, 5, 0, 1, 5, 2, 0, 135, 3, 2, 0, 5, 0, 0, 0, 119, 0, 224, 255, 135, 3, 56, 0, 139, 0, 0, 0, 140, 0, 9, 0, 0, 0, 0, 0, 2, 5, 0, 0, 85, 200, 16, 0, 136, 6, 0, 0, 0, 4, 6, 0, 136, 6, 0, 0, 25, 6, 6, 48, 137, 6, 0, 0, 25, 3, 4, 40, 25, 2, 4, 32, 25, 1, 4, 24, 0, 0, 4, 0, 78, 6, 5, 0, 120, 6, 26, 0, 2, 7, 0, 0, 31, 124, 15, 0, 1, 8, 19, 0, 134, 6, 0, 0, 100, 119, 0, 0, 7, 0, 8, 0, 33, 6, 6, 27, 121, 6, 24, 0, 2, 8, 0, 0, 51, 124, 15, 0, 135, 6, 32, 0, 0, 8, 0, 0, 120, 6, 8, 0, 1, 6, 1, 0, 83, 5, 6, 0, 2, 8, 0, 0, 57, 124, 15, 0, 135, 6, 23, 0, 8, 2, 0, 0, 119, 0, 12, 0, 2, 8, 0, 0, 86, 124, 15, 0, 135, 6, 23, 0, 8, 3, 0, 0, 119, 0, 7, 0, 1, 6, 0, 0, 83, 5, 6, 0, 2, 8, 0, 0, 1, 124, 15, 0, 135, 6, 23, 0, 8, 1, 0, 0, 137, 4, 0, 0, 139, 0, 0, 0, 140, 0, 8, 0, 0, 0, 0, 0, 2, 5, 0, 0, 76, 200, 16, 0, 1, 6, 0, 0, 83, 5, 6, 0, 135, 6, 55, 0, 1, 0, 0, 0, 2, 2, 0, 0, 224, 108, 16, 0, 1, 1, 0, 0, 0, 3, 2, 0, 78, 4, 3, 0, 41, 6, 4, 24, 42, 6, 6, 24, 0, 4, 6, 0, 32, 7, 4, 0, 121, 7, 4, 0, 1, 7, 32, 0, 0, 5, 7, 0, 119, 0, 2, 0, 0, 5, 4, 0, 1, 7, 7, 0, 135, 6, 121, 0, 5, 7, 1, 0, 25, 1, 1, 1, 32, 6, 1, 80, 120, 6, 3, 0, 25, 3, 3, 1, 119, 0, 239, 255, 25, 0, 0, 1, 32, 6, 0, 24, 120, 6, 3, 0, 25, 2, 2, 80, 119, 0, 232, 255, 134, 6, 0, 0, 4, 229, 0, 0, 135, 6, 56, 0, 139, 0, 0, 0, 140, 1, 5, 0, 0, 0, 0, 0, 136, 2, 0, 0, 0, 1, 2, 0, 136, 2, 0, 0, 25, 2, 2, 16, 137, 2, 0, 0, 2, 2, 0, 0, 136, 200, 16, 0, 2, 3, 0, 0, 136, 200, 16, 0, 82, 3, 3, 0, 25, 3, 3, 1, 85, 2, 3, 0, 134, 3, 0, 0, 12, 99, 0, 0, 135, 3, 23, 0, 0, 1, 0, 0, 1, 2, 7, 0, 135, 3, 2, 0, 2, 0, 0, 0, 1, 2, 1, 0, 135, 3, 25, 0, 2, 0, 0, 0, 120, 3, 25, 0, 2, 2, 0, 0, 89, 140, 15, 0, 25, 4, 1, 8, 135, 3, 23, 0, 2, 4, 0, 0, 1, 3, 1, 0, 1, 4, 8, 0, 135, 0, 31, 0, 3, 4, 0, 0, 2, 4, 0, 0, 92, 4, 16, 0, 82, 4, 4, 0, 4, 0, 4, 0, 2, 4, 0, 0, 92, 4, 16, 0, 85, 4, 0, 0, 34, 4, 0, 1, 121, 4, 7, 0, 1, 3, 102, 0, 134, 4, 0, 0, 120, 137, 0, 0, 3, 0, 0, 0, 137, 1, 0, 0, 139, 0, 0, 0, 137, 1, 0, 0, 139, 0, 0, 0, 140, 0, 5, 0, 0, 0, 0, 0, 2, 1, 0, 0, 157, 119, 15, 0, 2, 2, 0, 0, 118, 197, 15, 0, 135, 0, 174, 0, 1, 2, 0, 0, 121, 0, 53, 0, 2, 1, 0, 0, 172, 198, 16, 0, 1, 3, 156, 1, 1, 4, 1, 0, 135, 2, 175, 0, 1, 3, 4, 0, 2, 4, 0, 0, 72, 200, 16, 0, 1, 3, 148, 11, 1, 1, 1, 0, 135, 2, 175, 0, 4, 3, 1, 0, 2, 1, 0, 0, 192, 3, 16, 0, 1, 3, 224, 46, 1, 4, 1, 0, 135, 2, 175, 0, 1, 3, 4, 0, 2, 4, 0, 0, 160, 50, 16, 0, 1, 3, 244, 3, 1, 1, 1, 0, 135, 2, 175, 0, 4, 3, 1, 0, 2, 1, 0, 0, 160, 54, 16, 0, 1, 3, 224, 6, 1, 4, 1, 0, 135, 2, 175, 0, 1, 3, 4, 0, 2, 4, 0, 0, 128, 61, 16, 0, 1, 3, 224, 6, 1, 1, 1, 0, 135, 2, 175, 0, 4, 3, 1, 0, 2, 1, 0, 0, 168, 221, 16, 0, 1, 3, 4, 0, 1, 4, 1, 0, 135, 2, 175, 0, 1, 3, 4, 0, 2, 4, 0, 0, 96, 68, 16, 0, 1, 3, 0, 30, 1, 1, 1, 0, 135, 2, 175, 0, 4, 3, 1, 0, 135, 2, 176, 0, 0, 0, 0, 0, 134, 2, 0, 0, 128, 229, 0, 0, 139, 0, 0, 0, 140, 0, 4, 0, 0, 0, 0, 0, 136, 1, 0, 0, 0, 0, 1, 0, 136, 1, 0, 0, 25, 1, 1, 16, 137, 1, 0, 0, 2, 1, 0, 0, 76, 200, 16, 0, 1, 2, 0, 0, 83, 1, 2, 0, 2, 2, 0, 0, 128, 61, 16, 0, 2, 1, 0, 0, 60, 4, 16, 0, 78, 1, 1, 0, 26, 1, 1, 1, 2, 3, 0, 0, 59, 4, 16, 0, 78, 3, 3, 0, 27, 3, 3, 22, 3, 1, 1, 3, 90, 2, 2, 1, 32, 2, 2, 240, 121, 2, 14, 0, 1, 1, 22, 0, 135, 2, 2, 0, 1, 0, 0, 0, 2, 2, 0, 0, 136, 200, 16, 0, 2, 1, 0, 0, 136, 200, 16, 0, 82, 1, 1, 0, 25, 1, 1, 1, 85, 2, 1, 0, 134, 1, 0, 0, 12, 99, 0, 0, 119, 0, 5, 0, 2, 2, 0, 0, 249, 128, 15, 0, 135, 1, 23, 0, 2, 0, 0, 0, 137, 0, 0, 0, 139, 0, 0, 0, 140, 0, 3, 0, 0, 0, 0, 0, 135, 0, 55, 0, 2, 0, 0, 0, 172, 198, 16, 0, 1, 1, 1, 0, 83, 0, 1, 0, 134, 1, 0, 0, 148, 225, 0, 0, 2, 1, 0, 0, 168, 198, 16, 0, 1, 0, 0, 0, 85, 1, 0, 0, 1, 1, 0, 0, 135, 0, 49, 0, 1, 0, 0, 0, 1, 1, 11, 0, 2, 2, 0, 0, 127, 129, 15, 0, 135, 0, 57, 0, 1, 2, 0, 0, 1, 2, 13, 0, 2, 1, 0, 0, 140, 129, 15, 0, 135, 0, 57, 0, 2, 1, 0, 0, 134, 0, 0, 0, 4, 229, 0, 0, 33, 0, 0, 13, 121, 0, 8, 0, 1, 1, 2, 0, 135, 0, 2, 0, 1, 0, 0, 0, 134, 0, 0, 0, 4, 229, 0, 0, 33, 0, 0, 13, 120, 0, 250, 255, 2, 0, 0, 0, 74, 200, 16, 0, 1, 1, 1, 0, 83, 0, 1, 0, 139, 0, 0, 0, 140, 2, 4, 0, 0, 0, 0, 0, 135, 3, 51, 0, 135, 3, 101, 0, 1, 3, 20, 0, 134, 2, 0, 0, 16, 165, 0, 0, 3, 0, 0, 0, 121, 2, 252, 255, 2, 3, 0, 0, 152, 198, 16, 0, 82, 3, 3, 0, 28, 3, 3, 16, 85, 0, 3, 0, 2, 3, 0, 0, 156, 198, 16, 0, 82, 3, 3, 0, 28, 3, 3, 24, 85, 1, 3, 0, 139, 2, 0, 0, 140, 2, 7, 0, 0, 0, 0, 0, 78, 3, 1, 0, 32, 2, 3, 0, 41, 3, 0, 24, 42, 3, 3, 24, 120, 3, 19, 0, 121, 2, 21, 0, 2, 4, 0, 0, 97, 129, 15, 0, 2, 5, 0, 0, 242, 200, 16, 0, 1, 6, 20, 0, 134, 3, 0, 0, 100, 119, 0, 0, 4, 5, 6, 0, 2, 3, 0, 0, 242, 200, 16, 0, 78, 3, 3, 0, 121, 3, 9, 0, 2, 6, 0, 0, 242, 200, 16, 0, 135, 3, 81, 0, 1, 6, 0, 0, 119, 0, 4, 0, 120, 2, 3, 0, 1, 3, 0, 0, 83, 1, 3, 0, 139, 0, 0, 0, 140, 0, 3, 0, 0, 0, 0, 0, 136, 1, 0, 0, 0, 0, 1, 0, 136, 1, 0, 0, 25, 1, 1, 16, 137, 1, 0, 0, 2, 1, 0, 0, 251, 203, 16, 0, 78, 1, 1, 0, 120, 1, 9, 0, 2, 1, 0, 0, 251, 203, 16, 0, 1, 2, 1, 0, 83, 1, 2, 0, 2, 1, 0, 0, 49, 134, 15, 0, 135, 2, 23, 0, 1, 0, 0, 0, 134, 2, 0, 0, 204, 153, 0, 0, 137, 0, 0, 0, 139, 0, 0, 0, 140, 0, 3, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 2, 0, 0, 135, 2, 51, 0, 135, 2, 101, 0, 1, 2, 20, 0, 134, 0, 0, 0, 16, 165, 0, 0, 2, 0, 0, 0, 20, 2, 0, 1, 52, 2, 2, 1, 28, 229, 0, 0, 139, 0, 0, 0, 140, 2, 3, 0, 0, 0, 0, 0, 134, 2, 0, 0, 92, 229, 0, 0, 134, 2, 0, 0, 104, 145, 0, 0, 1, 2, 0, 0, 139, 2, 0, 0, 140, 0, 2, 0, 0, 0, 0, 0, 134, 0, 0, 0, 164, 229, 0, 0, 1, 1, 49, 0, 135, 0, 177, 0, 1, 0, 0, 0, 135, 0, 178, 0, 139, 0, 0, 0, 140, 0, 2, 0, 0, 0, 0, 0, 1, 1, 1, 0, 135, 0, 179, 0, 1, 0, 0, 0, 1, 1, 50, 0, 135, 0, 151, 0, 1, 0, 0, 0, 139, 0, 0, 0, 140, 0, 2, 0, 0, 0, 0, 0, 1, 1, 0, 0, 135, 0, 179, 0, 1, 0, 0, 0, 1, 1, 50, 0, 135, 0, 151, 0, 1, 0, 0, 0, 139, 0, 0, 0], eb + 51200);
    var relocations = [];
    relocations = relocations.concat([168, 172, 340, 468, 668, 688, 736, 940, 944, 948, 952, 956, 960, 1032, 1072, 1164, 1564, 1596, 1636, 1720, 2004, 2008, 2012, 2016, 2020, 2024, 2028, 2032, 2036, 2040, 2044, 2048, 2052, 2056, 2060, 2064, 2068, 2072, 2076, 2080, 2084, 2088, 2092, 2096, 2100, 2104, 2108, 2112, 2116, 2120, 2124, 2128, 2132, 2376, 2400, 2468, 3044, 3144, 3380, 3384, 3436, 3440, 3444, 3448, 3452, 3456, 3460, 3464, 3468, 3472, 3476, 3480, 3484, 3488, 3492, 3568, 3572, 3576, 3580, 3584, 3588, 3592, 3596, 3600, 3604, 3608, 3612, 3616, 3620, 3624, 3628, 3632, 3636, 3640, 3644, 3648, 3652, 3656, 3660, 3664, 3668, 3672, 3676, 3680, 3684, 3688, 3692, 3696, 3700, 3704, 3708, 3712, 3716, 3720, 3724, 3728, 3732, 3736, 3740, 3744, 3748, 3752, 3756, 3760, 3764, 3768, 3772, 3776, 3780, 3784, 3788, 3792, 3796, 3800, 3804, 3808, 3812, 3816, 3820, 3824, 3828, 3832, 3836, 3840, 3844, 3848, 3852, 3856, 3860, 3864, 3868, 3872, 3876, 3880, 3884, 3888, 3892, 3896, 3900, 3904, 3908, 3912, 3916, 3920, 3924, 3928, 3932, 3936, 3940, 3944, 3948, 3952, 3956, 3960, 3964, 3968, 3972, 3976, 3980, 3984, 3988, 3992, 3996, 4e3, 4004, 4008, 4012, 4016, 4020, 4024, 4028, 4032, 4036, 4040, 4044, 4048, 4052, 4056, 4060, 4064, 4068, 4072, 4076, 4080, 4084, 4088, 4092, 4096, 4100, 4104, 4108, 4112, 4116, 4120, 4124, 4128, 4132, 4136, 4140, 4144, 4148, 4152, 4156, 4160, 4236, 4812, 4816, 4820, 4824, 4828, 4832, 4836, 4840, 4844, 4848, 4852, 4856, 4860, 4864, 4868, 4872, 4876, 4880, 4884, 4888, 4892, 4896, 4900, 4904, 4908, 4912, 4916, 4920, 4924, 4928, 4932, 4936, 4940, 4944, 4948, 4952, 5516, 5520, 5524, 5528, 5532, 5536, 5540, 5544, 5548, 5552, 5556, 5560, 5564, 5568, 5572, 5576, 5580, 5584, 5588, 5592, 5596, 5600, 5604, 5608, 5612, 5616, 5620, 5624, 5628, 5632, 5636, 5640, 5644, 5648, 5652, 5656, 5660, 5664, 5668, 5672, 5676, 5680, 5684, 5688, 5692, 5696, 5700, 5704, 5708, 5712, 5716, 5720, 5724, 5728, 5732, 5736, 5740, 5744, 5748, 5752, 5756, 5760, 5764, 5768, 5772, 5776, 5780, 5784, 5788, 5792, 5796, 5800, 5804, 5808, 5812, 5816, 6448, 6452, 6456, 6460, 6612, 6616, 6620, 6624, 6628, 6632, 6636, 6640, 6644, 6648, 6652, 6656, 6660, 6664, 6668, 6672, 6676, 6680, 6836, 6840, 6844, 6848, 6852, 6856, 6860, 6864, 6868, 6872, 6876, 6880, 6884, 6888, 6892, 6896, 6900, 6904, 6908, 6912, 6916, 6920, 6924, 7e3, 7732, 7868, 7888, 7908, 7920, 8076, 8552, 9216, 9220, 9224, 9228, 9232, 9556, 9632, 9636, 9640, 9644, 9648, 9652, 9656, 9660, 9664, 9668, 9672, 9676, 9680, 9684, 9688, 9692, 9696, 9700, 9704, 9708, 9712, 9716, 9720, 9724, 9728, 9732, 9736, 9740, 9744, 9748, 9752, 9756, 9760, 9764, 9768, 9772, 9776, 9780, 9784, 9788, 9792, 9796, 9800, 9804, 9808, 9812, 9816, 9820, 9824, 9828, 9832, 9836, 9840, 9844, 9848, 9852, 9856, 9860, 9864, 9868, 9872, 9876, 9880, 9884, 9888, 9892, 9896, 9900, 9904, 9908, 9912, 9916, 9920, 9924, 9928, 9932, 9936, 9940, 9944, 9948, 9952, 9956, 9960, 9964, 9968, 9972, 9976, 9980, 9984, 9988, 9992, 9996, 1e4, 10004, 10008, 10012, 10016, 10020, 10024, 10028, 10032, 10036, 10040, 10520, 10592, 10748, 11268, 11348, 11560, 11564, 11568, 11572, 11576, 11580, 11584, 11588, 11592, 11596, 11600, 11604, 11608, 11612, 11616, 11620, 11624, 11628, 11632, 11636, 11640, 11644, 11648, 11652, 11656, 11660, 11664, 11668, 11672, 11676, 11680, 11684, 11688, 11692, 11696, 11700, 11704, 11708, 11712, 11716, 11720, 11724, 11728, 11732, 11736, 11740, 11744, 11748, 11752, 11756, 11760, 11764, 11768, 11772, 11776, 11780, 11784, 11788, 11792, 11796, 11800, 11804, 11808, 11812, 11816, 11820, 11824, 11828, 11832, 11836, 11840, 11844, 11848, 11852, 11856, 11860, 11864, 11868, 11872, 11876, 11880, 11884, 11888, 11892, 11896, 11900, 11904, 11908, 11912, 11916, 11920, 11924, 11928, 11932, 13060, 13064, 13440, 13444, 13512, 13516, 14104, 14108, 14112, 14116, 14120, 14124, 14128, 14132, 14136, 14140, 14144, 14148, 14152, 14156, 14160, 14164, 14168, 14172, 14176, 14180, 14184, 14188, 14192, 14196, 14200, 14204, 14208, 14212, 14216, 14220, 14224, 14228, 14232, 14236, 14240, 14244, 14248, 14252, 14256, 14260, 14264, 14268, 14272, 14276, 14280, 14284, 14288, 14292, 14296, 14300, 14304, 14308, 14312, 14316, 14320, 14324, 14328, 14332, 14336, 14340, 14344, 14348, 14352, 14356, 14360, 14364, 14368, 14372, 14376, 14380, 14384, 14388, 14392, 14396, 14400, 14404, 14408, 14412, 14416, 14420, 14424, 14428, 14432, 14436, 14440, 14444, 14448, 14452, 14456, 14460, 14464, 14468, 14472, 14476, 14480, 14484, 14488, 14492, 14496, 14500, 14504, 14508, 14512, 14516, 14520, 14524, 14528, 14532, 14816, 14820, 14824, 14828, 14832, 14836, 14840, 14844, 15096, 15100, 15104, 15108, 15112, 15116, 15120, 15124, 15128, 15160, 15416, 15420, 15424, 15428, 15432, 15436, 15440, 15444, 15448, 15452, 16060, 16064, 16068, 16072, 16084, 16192, 16248, 16384, 16388, 16392, 16396, 16412, 16756, 16820, 16824, 16828, 16832, 17112, 17116, 17120, 17124, 17128, 17132, 17136, 17140, 17144, 17148, 17152, 17156, 17160, 17164, 17168, 17172, 17176, 17180, 17184, 17188, 17192, 17196, 17200, 17204, 17208, 17212, 17216, 17220, 17224, 17228, 17232, 17236, 17240, 17244, 17248, 17252, 17256, 17260, 17264, 17268, 17272, 17276, 17280, 17284, 17288, 17292, 17296, 17300, 17304, 17308, 17312, 17316, 17320, 17324, 17328, 17332, 17336, 17340, 17344, 17348, 17352, 17356, 17360, 17364, 17368, 17372, 17376, 17380, 17384, 17388, 17392, 17396, 17400, 17404, 17408, 17412, 17416, 17420, 17424, 17428, 17432, 17436, 17440, 17444, 17448, 17452, 17456, 17460, 17464, 17468, 17472, 17476, 17480, 17484, 17488, 17492, 17496, 17500, 17504, 17508, 17512, 17516, 17520, 17524, 17528, 17532, 17536, 17540, 17544, 17548, 17552, 17556, 17560, 17564, 17568, 17572, 17576, 17580, 17584, 17588, 17592, 17596, 17600, 17604, 17608, 17612, 17616, 17620, 17624, 17628, 17632, 17636, 17640, 17644, 17648, 17652, 17656, 17660, 17664, 17668, 18428, 18460, 18464, 18468, 18472, 18512, 18516, 18608, 18736, 18792, 18852, 18908, 19052, 19068, 19072, 19076, 19080, 19084, 19088, 19092, 19096, 19100, 19104, 19108, 19112, 19116, 19120, 19124, 19128, 19132, 19136, 19140, 19144, 19148, 19152, 19156, 19160, 19164, 19168, 19172, 19176, 19180, 19184, 19188, 19192, 19196, 19200, 19204, 19208, 19212, 19216, 19220, 19224, 19228, 19232, 19236, 19240, 19244, 19248, 19252, 19256, 19260, 19264, 19268, 19272, 19276, 19280, 19284, 19288, 19292, 19296, 19300, 19304, 19308, 19312, 19316, 19320, 19324, 19328, 19332, 19336, 19340, 19344, 19348, 19352, 19356, 19360, 19364, 19368, 19372, 19376, 19380, 19384, 19388, 19392, 19396, 19400, 19404, 19408, 19412, 19416, 19420, 19424, 19428, 19432, 19436, 19440, 19444, 19448, 19452, 19456, 19460, 19464, 19468, 19472, 19476, 19480, 19484, 19488, 19492, 19496, 19500, 19504, 19508, 19512, 19516, 19520, 19524, 19528, 19532, 19536, 19540, 19544, 19548, 19552, 19556, 19560, 19564, 19568, 19572, 19576, 19580, 19584, 19588, 19592, 19596, 19600, 19604, 19608, 19612, 19616, 19620, 19624, 19628, 19632, 19636, 19640, 19644, 19648, 19652, 19656, 19660, 19664, 19668, 19672, 19676, 19680, 19684, 19688, 19692, 19696, 19700, 19704, 19708, 19712, 19716, 19720, 19724, 19728, 19732, 19736, 19740, 19744, 19748, 19752, 19756, 19760, 19764, 19768, 19772, 19776, 19780, 19784, 19788, 19792, 19796, 19800, 19804, 19808, 19812, 19816, 19820, 19824, 19828, 19832, 19836, 19840, 19844, 19848, 19852, 19856, 19860, 19864, 19868, 19872, 19876, 19880, 19884, 19888, 19892, 19896, 19900, 19904, 19908, 19912, 19916, 19920, 19924, 19928, 19932, 19936, 19940, 19944, 19948, 19952, 19956, 19960, 19964, 19968, 19972, 19976, 19980, 19984, 19988, 19992, 19996, 2e4, 20004, 20008, 20012, 20016, 20020, 20024, 20028, 20032, 20036, 20040, 20044, 20048, 20052, 20056, 20060, 20064, 20068, 20072, 20076, 20080, 20084, 20088, 20092, 20096, 20100, 20104, 20108, 20112, 20116, 20120, 20124, 20128, 20132, 20136, 20140, 20144, 20148, 20152, 20156, 20160, 20164, 20168, 20172, 20176, 20180, 20184, 20188, 20192, 20196, 20200, 20204, 20208, 20212, 20216, 20220, 20224, 20228, 20232, 20236, 20240, 20244, 20248, 20252, 20256, 20260, 20264, 20268, 20272, 20276, 20280, 20284, 20288, 20292, 20296, 20300, 20304, 20308, 20312, 20316, 20320, 20324, 20328, 20332, 20336, 20340, 20344, 20348, 20352, 20356, 20360, 20364, 20368, 20372, 20376, 20380, 20384, 20388, 20392, 20396, 20400, 20404, 20408, 20412, 20416, 20420, 20424, 20428, 20432, 20436, 20440, 20444, 20448, 20452, 20456, 20460, 20464, 20468, 20472, 20476, 20480, 20484, 20488, 20492, 20496, 20500, 20504, 20508, 20512, 20516, 20520, 20524, 20528, 20532, 20536, 20540, 20544, 20548, 20552, 20556, 20560, 20564, 20568, 20572, 20576, 20580, 20584, 20588, 20592, 20596, 20600, 20604, 20608, 20612, 20616, 20620, 20624, 20628, 20632, 20636, 20640, 20644, 20648, 20652, 20656, 20660, 20664, 20668, 20672, 20676, 20680, 20684, 20688, 20692, 20696, 20700, 20704, 20708, 20712, 20716, 20720, 20724, 20728, 20732, 20736, 20740, 20744, 20748, 20752, 20756, 20760, 20764, 20768, 20772, 20776, 20780, 20784, 20788, 20792, 20796, 20800, 20804, 20808, 20812, 20816, 20820, 20824, 20828, 20832, 20836, 20840, 20844, 20848, 20852, 20856, 20860, 20864, 20868, 20872, 20876, 20880, 20884, 20888, 20892, 20896, 20900, 20904, 20908, 20912, 20916, 20920, 20924, 20928, 20932, 20936, 20940, 20944, 20948, 20952, 20956, 20960, 20964, 20968, 20972, 20976, 20980, 20984, 20988, 20992, 20996, 21e3, 21004, 21008, 21012, 21016, 21020, 21024, 21028, 21032, 21036, 21040, 21044, 21048, 21052, 21056, 21060, 21064, 21080, 21108, 21136, 21556, 21584, 21988, 21992, 21996, 22e3, 22004, 22008, 22012, 22016, 22020, 22024, 22028, 22032, 22036, 22040, 22044, 22048, 22052, 22056, 22060, 22064, 22068, 22072, 22076, 22080, 22084, 22088, 22092, 22096, 22100, 22104, 22108, 22112, 22116, 22120, 22124, 22128, 22132, 22136, 22140, 22144, 22148, 22152, 22156, 22160, 22164, 22168, 22172, 22176, 22180, 22184, 22188, 22192, 22196, 22200, 22204, 22208, 22212, 22216, 22220, 22224, 22228, 22232, 22236, 22240, 22244, 22248, 22252, 22256, 22260, 22264, 22268, 22272, 22276, 22280, 22284, 22288, 22292, 22296, 22300, 22304, 22308, 22312, 22316, 22320, 22324, 22328, 22332, 22336, 22340, 22344, 22348, 22352, 22356, 22360, 22364, 22368, 22372, 22376, 22380, 22384, 22388, 22392, 22396, 22400, 22404, 22408, 22412, 22416, 22420, 22424, 22428, 22432, 23012, 23016, 23020, 23024, 23028, 23320, 23324, 23328, 23332, 23336, 23340, 24628, 24632, 24636, 24640, 24644, 24648, 24652, 24656, 24660, 24664, 24668, 24672, 24676, 24680, 24684, 25496, 25772, 25776, 25780, 25784, 25788, 25792, 25796, 25800, 25804, 25808, 25812, 25816, 25820, 25824, 25828, 25832, 25836, 25840, 25844, 25848, 25852, 25856, 25860, 25864, 25868, 25872, 25876, 25880, 25884, 25888, 25892, 25896, 25900, 25904, 25908, 25912, 25916, 25920, 25924, 25928, 25932, 25936, 25940, 25944, 25948, 25952, 25956, 25960, 25964, 25968, 25972, 25976, 25980, 25984, 25988, 25992, 25996, 26e3, 26004, 26008, 26012, 26016, 26020, 26024, 26028, 26032, 26036, 26040, 26044, 26048, 26052, 26056, 26060, 26064, 26116, 26220, 26224, 26228, 26232, 26236, 26240, 26244, 26248, 26252, 26256, 26260, 26264, 26268, 26272, 26276, 26280, 26284, 26288, 26292, 26296, 26300, 26304, 26308, 26312, 26316, 26320, 26324, 26328, 26332, 26336, 26340, 26344, 26348, 26352, 26356, 26360, 26364, 26368, 26372, 26376, 26380, 26384, 26388, 26392, 26396, 26400, 26404, 26408, 26412, 26416, 26420, 26424, 26428, 26432, 26436, 26440, 26444, 26448, 26452, 26456, 26460, 26464, 26468, 26472, 26476, 26480, 26484, 26488, 26492, 26496, 26500, 26504, 26508, 26512, 26632, 26636, 26640, 26644, 26648, 26652, 26656, 26660, 26664, 26668, 26672, 26676, 26680, 26684, 26688, 26692, 26696, 26700, 26704, 26708, 26712, 26716, 26720, 26724, 26728, 26732, 26736, 26740, 26744, 26748, 26752, 26756, 26760, 26764, 26768, 26772, 26776, 26780, 26784, 26788, 26792, 26796, 26800, 26804, 26808, 26812, 26816, 26820, 26824, 26828, 26832, 26836, 26840, 26844, 26848, 26852, 26856, 26860, 26864, 26868, 26872, 26876, 26880, 26884, 26888, 26892, 26896, 26900, 26904, 26908, 26912, 26916, 26920, 26924, 27548, 27700, 27736, 27852, 27884, 27984, 28204, 28304, 28312, 28764, 29244, 29292, 29296, 29300, 29304, 29308, 29312, 29316, 29320, 29324, 29328, 29332, 29336, 29340, 29344, 29348, 29528, 30188, 30328, 30396, 30400, 30404, 30408, 30412, 30416, 30420, 30424, 30428, 30432, 30436, 30440, 30444, 30448, 30452, 30456, 30460, 30464, 30468, 30472, 30476, 30480, 30484, 30488, 30492, 30496, 30500, 30504, 30508, 30512, 30516, 30520, 30524, 30776, 30780, 30784, 30788, 30792, 30796, 30800, 30804, 30808, 30812, 30816, 30820, 30824, 30828, 30832, 30836, 30840, 30844, 30848, 30852, 30856, 30860, 30864, 30868, 30872, 30876, 30880, 30884, 30888, 30892, 30896, 30900, 30904, 30908, 30912, 30916, 30920, 30924, 30928, 30932, 30936, 30940, 30944, 30948, 30952, 30956, 30960, 30964, 30968, 30972, 30976, 30980, 30984, 30988, 30992, 30996, 31e3, 31004, 31008, 31012, 31016, 31020, 31024, 31028, 31032, 31036, 31040, 31044, 31048, 31052, 31056, 31060, 31064, 31068, 31072, 31076, 31080, 31084, 31088, 31092, 31096, 31100, 31104, 31108, 31112, 31116, 31120, 31124, 31128, 31132, 31136, 31140, 31144, 31148, 31152, 31156, 31160, 31164, 31168, 31172, 31176, 31180, 31184, 31188, 31192, 31196, 31200, 31204, 31208, 31212, 31216, 31220, 31224, 31228, 31232, 31236, 31240, 31244, 31248, 31252, 31256, 31260, 31264, 31268, 31272, 31276, 31280, 31284, 31288, 31292, 31296, 31300, 31304, 31308, 31312, 31316, 31320, 31324, 31328, 31332, 31336, 31340, 31344, 31348, 31352, 31416, 31420, 31424, 31428, 31432, 31436, 31440, 31444, 31448, 31452, 31456, 31460, 31464, 31468, 31472, 31976, 32024, 32028, 32032, 32036, 32040, 32044, 32048, 32052, 32056, 32060, 32064, 32068, 32072, 32076, 32232, 32852, 32856, 32860, 32864, 32868, 32872, 32876, 32880, 32884, 32888, 32892, 32896, 32900, 32904, 32908, 32912, 32916, 32920, 32924, 32928, 32932, 32936, 32940, 32944, 32948, 32952, 32956, 32960, 32964, 32968, 32972, 32976, 32980, 32984, 32988, 32992, 32996, 33e3, 33004, 33008, 33012, 33016, 33020, 33024, 33028, 33032, 33036, 33040, 33044, 33048, 33052, 33056, 33060, 33064, 33068, 33072, 33076, 33080, 33084, 33088, 33092, 33096, 33100, 33104, 33108, 33112, 33116, 33120, 33124, 33128, 33132, 33136, 33140, 33144, 33148, 33152, 33156, 33160, 33164, 33168, 33172, 33176, 33180, 33184, 33188, 33192, 33196, 33200, 33204, 33208, 33212, 33216, 33220, 33224, 33228, 33232, 33236, 33240, 33244, 33248, 33252, 33256, 33260, 33264, 33268, 33272, 33276, 33280, 33284, 33288, 33292, 33296, 33300, 33304, 33308, 33312, 33316, 33320, 33324, 33328, 33332, 33336, 33340, 33344, 33348, 33352, 33356, 33360, 33364, 33368, 33372, 33376, 33380, 33384, 33388, 33392, 33396, 33400, 33404, 33408, 33724, 33728, 33732, 33736, 33740, 33744, 33748, 33752, 33756, 33760, 33764, 33768, 33772, 33776, 33780, 33784, 33788, 33792, 33796, 33800, 33804, 33808, 33812, 33816, 33820, 33824, 33828, 33832, 33836, 33840, 33844, 33848, 33852, 33856, 33860, 33864, 33868, 33872, 33876, 33880, 33884, 33888, 33892, 33896, 33900, 33904, 33908, 33912, 33916, 33920, 33924, 33928, 33932, 33936, 33940, 33944, 33948, 33952, 33956, 33960, 33964, 33968, 33972, 33976, 33980, 33984, 33988, 33992, 33996, 34e3, 34004, 34008, 34012, 34016, 34136, 34252, 34652, 34744, 34896, 35060, 35064, 35068, 35072, 35076, 35080, 35084, 35088, 35092, 35096, 35100, 35104, 35108, 35112, 35116, 35120, 35124, 35128, 35132, 35136, 35624, 35876, 35880, 35884, 35888, 35892, 35896, 35900, 35904, 35908, 35912, 35916, 35920, 36468, 37388, 37432, 37956, 38048, 38052, 38056, 38060, 38064, 38068, 38072, 38076, 38080, 38084, 38088, 38092, 38096, 38100, 38104, 38108, 38112, 38116, 38120, 38124, 38128, 38132, 38136, 38140, 38144, 38148, 38152, 38156, 38160, 38164, 38168, 38172, 38176, 38180, 38184, 38188, 38192, 38196, 38200, 38204, 38208, 38212, 38216, 38220, 38224, 38228, 38232, 38236, 38240, 38244, 38248, 38252, 38256, 38260, 38264, 38268, 38272, 38276, 38280, 38284, 38288, 38292, 38296, 38300, 38304, 38308, 38312, 38316, 38320, 38324, 38328, 38332, 38336, 38340, 38344, 38348, 38352, 38356, 38360, 38364, 38368, 38372, 38376, 38380, 38384, 38388, 38392, 38396, 38400, 38404, 38408, 38412, 38416, 38420, 38424, 38428, 38432, 38436, 38440, 38444, 38448, 38452, 38456, 38460, 38464, 38468, 38472, 38476, 38480, 38484, 38488, 38492, 38496, 38500, 38504, 38508, 38512, 38516, 38520, 38524, 38528, 38532, 38536, 38540, 38544, 38548, 38552, 38556, 38560, 38564, 38568, 38572, 38576, 38580, 38584, 38588, 38592, 38596, 38600, 38604, 38784, 38812, 39048, 39500, 39504, 39508, 39512, 39516, 39520, 39524, 39528, 39532, 39536, 39540, 39544, 39548, 39552, 39556, 39560, 39564, 39568, 39572, 39576, 39580, 39584, 39588, 39592, 39596, 39600, 39604, 39608, 39612, 39616, 39620, 39624, 39628, 39632, 39636, 39640, 39644, 39648, 39652, 39656, 39660, 39664, 39668, 39672, 39676, 39680, 39684, 39688, 39692, 39696, 39700, 39704, 39708, 39712, 39716, 39720, 39724, 39728, 39732, 39736, 39740, 39744, 39748, 39752, 39756, 39760, 39764, 39768, 39772, 39776, 39780, 39784, 39788, 39792, 39796, 39800, 39804, 39808, 39812, 39816, 39820, 39824, 39828, 39832, 39836, 39840, 39844, 39848, 39852, 39856, 39860, 39864, 39868, 39872, 39876, 39880, 39884, 39888, 39892, 39896, 39900, 39904, 39908, 39912, 39916, 39920, 39924, 39928, 40700, 40704, 40708, 40712, 40716, 40720, 40724, 40728, 40732, 40736, 40740, 40744, 40748, 40752, 40756, 40760, 40764, 40768, 40772, 40776, 40780, 40784, 40788, 40792, 40796, 40800, 40804, 40808, 40812, 40816, 40820, 40824, 40828, 40832, 40836, 40840, 40844, 40848, 40852, 40856, 40860, 40864, 40868, 40872, 40876, 40880, 40884, 40888, 40892, 40896, 40900, 40904, 40908, 40912, 40916, 40920, 40924, 40928, 40932, 40936, 40940, 40944, 40948, 40952, 40956, 40960, 40964, 40968, 40972, 40976, 40980, 40984, 40988, 40992, 41448, 41612, 41704, 41936, 42244, 42392, 42396, 42400, 42404, 42408, 42412, 42416, 42420, 42424, 42428, 42432, 42436, 42440, 42444, 42448, 42452, 42456, 42460, 42464, 42468, 42472, 42476, 42480, 42484, 42488, 42492, 42496, 42500, 42504, 42508, 42512, 42516, 42520, 42524, 42528, 42532, 42536, 42540, 42544, 42548, 42552, 42556, 42560, 42564, 42568, 42572, 42576, 42580, 42584, 42588, 42592, 42596, 42600, 42604, 42608, 42612, 42616, 42620, 42624, 42628, 42632, 42636, 42640, 42644, 42648, 42652, 42656, 42660, 42664, 42668, 42672, 42676, 42680, 42684, 42688, 42692, 42696, 42700, 42704, 42708, 42712, 42716, 42720, 42724, 42728, 42732, 42736, 42740, 42744, 42748, 42752, 42756, 42760, 42764, 42768, 42772, 42776, 42780, 42784, 42788, 42792, 42796, 42800, 42804, 42808, 42812, 42816, 42820, 42824, 42828, 42832, 42836, 42840, 42844, 42848, 42852, 42856, 42860, 42864, 42868, 42872, 42876, 42880, 42884, 42888, 42892, 42896, 42900, 42904, 42908, 42912, 42916, 42920, 42924, 42928, 42932, 42936, 42940, 42944, 42948, 42952, 42956, 42960, 42964, 42968, 42972, 42976, 42980, 42984, 42988, 42992, 42996, 43e3, 43004, 43008, 43012, 43016, 43020, 43024, 43028, 43032, 43036, 43040, 43044, 43048, 43052, 43056, 43060, 43064, 43068, 43072, 43076, 43080, 43084, 43088, 43092, 43096, 43100, 43104, 43108, 43112, 43116, 43120, 43124, 43128, 43132, 43136, 43140, 43144, 43148, 43152, 43156, 43160, 43164, 43168, 43172, 43176, 43180, 43184, 43188, 43192, 43196, 43200, 43204, 43208, 43212, 43216, 43220, 43224, 43228, 43232, 43236, 43240, 43244, 43248, 43252, 43256, 43260, 43264, 43268, 43272, 43276, 43280, 43284, 43288, 43292, 43296, 43300, 43304, 43308, 43312, 43316, 43320, 43324, 43328, 43332, 43336, 43340, 43344, 43348, 43352, 43356, 43360, 43364, 43368, 43372, 43376, 43380, 43384, 43388, 43392, 43396, 43400, 43404, 43408, 43412, 43416, 43420, 43784, 43788, 43792, 43796, 43800, 43804, 43808, 43812, 43816, 43820, 43824, 43828, 43832, 43836, 43840, 43844, 43848, 43852, 43856, 43860, 43864, 43868, 43872, 43876, 43880, 43884, 43888, 43892, 43896, 43900, 43904, 43908, 43912, 43916, 43920, 43924, 43928, 43932, 43936, 43940, 43944, 43948, 43952, 43956, 43960, 43964, 43968, 43972, 43976, 43980, 43984, 43988, 43992, 43996, 44e3, 44004, 44008, 44012, 44016, 44020, 44024, 44028, 44032, 44036, 44040, 44044, 44048, 44052, 44056, 44060, 44064, 44068, 44072, 44076, 44080, 44084, 44088, 44092, 44096, 44100, 44104, 44108, 44112, 44116, 44120, 44124, 44128, 44132, 44136, 44140, 44144, 44148, 44152, 44156, 44160, 44164, 44168, 44580, 44616, 44644, 44648, 44652, 44656, 44660, 44664, 44668, 44672, 44676, 44680, 44816, 44920, 44932, 44952, 45016, 45148, 45176, 45228, 45232, 45236, 45240, 46088, 46424, 47064, 47068, 47072, 47076, 47080, 47084, 47852, 47856, 47860, 47864, 47868, 47872, 47876, 47880, 47884, 47888, 47892, 47896, 47900, 47904, 47908, 47912, 47916, 47920, 47924, 47928, 47932, 47936, 47940, 47944, 47948, 47952, 47956, 47960, 47964, 47968, 47972, 47976, 47980, 47984, 47988, 47992, 47996, 48e3, 48004, 48008, 48012, 48016, 48020, 48024, 48028, 48032, 48036, 48040, 48044, 48048, 48052, 48056, 48060, 48064, 48068, 48072, 48076, 48080, 48084, 48088, 48092, 48096, 48100, 48104, 48108, 48112, 48116, 48120, 48124, 48128, 48132, 48136, 48140, 48144, 48148, 48152, 48156, 48160, 48164, 48168, 48172, 48176, 48180, 48184, 48188, 48192, 48196, 48200, 48204, 48208, 48212, 48216, 48220, 48224, 48228, 48232, 48236, 48240, 48244, 48248, 48252, 48256, 48260, 48264, 48268, 48272, 48276, 48280, 48284, 48288, 48292, 48296, 48300, 48304, 48308, 48312, 48316, 48320, 48324, 48328, 48332, 48336, 48340, 48344, 48348, 48352, 48356, 48360, 48364, 48368, 48372, 48376, 48380, 48384, 48388, 48392, 48396, 48400, 48404, 48408, 48472, 48476, 48480, 48484, 48488, 48492, 48496, 48500, 48504, 48508, 48512, 48516, 48520, 48524, 48528, 48532, 48536, 48540, 48544, 48548, 48552, 48556, 48560, 48564, 48568, 48572, 48576, 48580, 48584, 48588, 48592, 48596, 48600, 48604, 48608, 48612, 48616, 48620, 48624, 48628, 48632, 48636, 48640, 48644, 48648, 48652, 48656, 48660, 48664, 48668, 48672, 48676, 48680, 48684, 48688, 48692, 48696, 48700, 48704, 48708, 48712, 48716, 48720, 48724, 48728, 48732, 48736, 48740, 48744, 48748, 48752, 48756, 48760, 48764, 48768, 48772, 48776, 48780, 48784, 48788, 48792, 48796, 48800, 48804, 49112, 49568, 49608, 49612, 49616, 49620, 49624, 49628, 49632, 49636, 49640, 49644, 49772, 49948, 49952, 49956, 49960, 49964, 49968, 49972, 49976, 49980, 49984, 49988, 49992, 49996, 5e4, 50004, 50008, 50012, 50016, 50020, 50024, 50028, 50032, 50036, 50040, 50044, 50048, 50052, 50056, 50060, 50064, 50068, 50072, 50076, 50080, 50084, 50088, 50092, 50096, 50100, 50104, 50108, 50112, 50116, 50120, 50124, 50128, 50132, 50136, 50140, 50144, 50148, 50152, 50156, 50160, 50164, 50168, 50172, 50176, 50180, 50184, 50188, 50192, 50196, 50200, 50204, 50208, 50212, 50216, 50220, 50224, 50228, 50232, 50236, 50240, 50244, 50248, 50252, 50256, 50260, 50264, 50268, 50272, 50276, 50280, 50284, 50288, 50292, 50296, 50300, 50304, 50308, 50312, 50316, 50320, 50324, 50328, 50332, 50336, 50340, 50344, 50348, 50352, 50356, 50360, 50364, 50368, 50372, 50376, 50380, 50384, 50388, 50392, 50396, 50400, 50404, 50408, 50412, 50416, 50420, 50424, 50428, 50432, 50436, 50440, 50444, 50448, 50452, 50456, 50460, 50464, 50468, 50472, 50476, 50480, 50484, 50488, 50492, 50496, 50500, 50504, 50552, 50556, 50560, 50564, 50568, 50572, 50576, 50612, 50616, 50620, 50624, 50628, 50632, 50992, 50996, 51e3, 51004, 51008, 51012, 51016, 51020, 51024, 51028, 51032, 51036, 51040, 51044, 51048, 51052, 51056, 51060, 51064, 51068, 51072, 51076, 51080, 51084, 51088, 51092, 51096, 51100, 51104, 51108, 51112, 51116, 51120, 51124, 51128, 51132, 51136, 51140, 51144, 51148, 51152, 51156, 51160, 51164, 51168, 51172, 51176, 51180, 51184, 51188, 51192, 51196, 51200, 51204, 51208, 51212, 51216, 51220, 51224, 51228, 51232, 51236, 51240, 51244, 51248, 51252, 51256, 51260, 51264, 51268, 51272, 51276, 51280, 51284, 51288, 51292, 51296, 51300, 51304, 51308, 51312, 51316, 51320, 51324, 51328, 51332, 51336, 51340, 51344, 51348, 51352, 51356, 51360, 51364, 51368, 51372, 51376, 51380, 51384, 51388, 51392, 51396, 51400, 51404, 51408, 51412, 51416, 51420, 51424, 51428, 51432, 51436, 51440, 51444, 51448, 51452, 51456, 51460, 51464, 51468, 51472, 51476, 51480, 51484, 51488, 51492, 51496, 51500, 51504, 51508, 51512, 51516, 51520, 51524, 51528, 51532, 51536, 51540, 51544, 51548, 51840, 52020, 53104, 53108, 53112, 53116, 53120, 53124, 53128, 53132, 53136, 53140, 53144, 53148, 53152, 53156, 53160, 53164, 53168, 53172, 53176, 53180, 54756, 54816, 54820, 54824, 54828, 54832, 54836, 54840, 54844, 54848, 54852, 54856, 54860, 54864, 54868, 54872, 54876, 54880, 54884, 54888, 54892, 54896, 54900, 54904, 54908, 54912, 54916, 54920, 54924, 54928, 54932, 54936, 54940, 54944, 56596, 57076, 57080, 57084, 57088, 57092, 57096, 57100, 57104, 57108, 57112, 57116, 57120, 57124, 57128, 57132, 57136, 57140, 57144, 57148, 57152, 58676, 1396, 1604, 3068, 3308, 3352, 3364, 3508, 6524, 6772, 8592, 8844, 10880, 10936, 11008, 11284, 11544, 12088, 12100, 12112, 12124, 12224, 12236, 12372, 12388, 12400, 12412, 12424, 12436, 12452, 12476, 12572, 12676, 12688, 12700, 12736, 12772, 12804, 12816, 12828, 12848, 12928, 12944, 13244, 13412, 13484, 13968, 13980, 14008, 15860, 17096, 18696, 22816, 22964, 23100, 23376, 23704, 24176, 24452, 24696, 24712, 24728, 24788, 24864, 24924, 25e3, 25060, 25144, 25160, 25176, 25192, 25208, 25224, 25288, 25304, 25320, 25336, 25424, 27144, 27304, 28164, 28568, 28616, 28644, 29032, 29060, 29160, 29408, 29576, 29680, 30356, 30652, 30760, 31896, 32280, 32384, 32836, 34060, 34076, 35044, 35364, 35776, 35856, 36012, 36116, 36132, 36164, 36572, 36676, 37328, 37344, 37468, 37480, 37500, 37600, 37640, 37724, 37772, 38032, 39152, 39188, 39284, 39456, 40388, 41240, 43736, 44512, 44748, 44768, 45056, 45088, 45360, 45608, 45860, 46700, 46796, 46984, 47204, 47816, 48972, 49124, 49712, 49732, 49912, 50976, 52044, 52236, 52280, 52484, 53088, 53264, 53608, 53916, 54404, 54492, 54780, 55124, 55172, 55416, 55796, 55864, 55880, 56208, 56232, 56336, 56608, 56820, 57060, 57272, 57532, 57604, 57724, 57988, 58140, 58204, 58280, 58308, 58364, 58476, 58616, 58660, 58696, 58704, 58728]);
    for (var i = 0; i < relocations.length; i++) { HEAPU32[eb + relocations[i] >> 2] = HEAPU32[eb + relocations[i] >> 2] + eb }
}));
var ENV = {};

function ___buildEnvironment(environ) {
    var MAX_ENV_VALUES = 64;
    var TOTAL_ENV_SIZE = 1024;
    var poolPtr;
    var envPtr;
    if (!___buildEnvironment.called) {
        ___buildEnvironment.called = true;
        ENV["USER"] = ENV["LOGNAME"] = "web_user";
        ENV["PATH"] = "/";
        ENV["PWD"] = "/";
        ENV["HOME"] = "/home/web_user";
        ENV["LANG"] = "C.UTF-8";
        ENV["_"] = Module["thisProgram"];
        poolPtr = getMemory(TOTAL_ENV_SIZE);
        envPtr = getMemory(MAX_ENV_VALUES * 4);
        HEAP32[envPtr >> 2] = poolPtr;
        HEAP32[environ >> 2] = envPtr
    } else {
        envPtr = HEAP32[environ >> 2];
        poolPtr = HEAP32[envPtr >> 2]
    }
    var strings = [];
    var totalSize = 0;
    for (var key in ENV) {
        if (typeof ENV[key] === "string") {
            var line = key + "=" + ENV[key];
            strings.push(line);
            totalSize += line.length
        }
    }
    if (totalSize > TOTAL_ENV_SIZE) { throw new Error("Environment size exceeded TOTAL_ENV_SIZE!") }
    var ptrSize = 4;
    for (var i = 0; i < strings.length; i++) {
        var line = strings[i];
        writeAsciiToMemory(line, poolPtr);
        HEAP32[envPtr + i * ptrSize >> 2] = poolPtr;
        poolPtr += line.length + 1
    }
    HEAP32[envPtr + strings.length * ptrSize >> 2] = 0
}

function ___lock() {}
var ERRNO_CODES = { EPERM: 1, ENOENT: 2, ESRCH: 3, EINTR: 4, EIO: 5, ENXIO: 6, E2BIG: 7, ENOEXEC: 8, EBADF: 9, ECHILD: 10, EAGAIN: 11, EWOULDBLOCK: 11, ENOMEM: 12, EACCES: 13, EFAULT: 14, ENOTBLK: 15, EBUSY: 16, EEXIST: 17, EXDEV: 18, ENODEV: 19, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENFILE: 23, EMFILE: 24, ENOTTY: 25, ETXTBSY: 26, EFBIG: 27, ENOSPC: 28, ESPIPE: 29, EROFS: 30, EMLINK: 31, EPIPE: 32, EDOM: 33, ERANGE: 34, ENOMSG: 42, EIDRM: 43, ECHRNG: 44, EL2NSYNC: 45, EL3HLT: 46, EL3RST: 47, ELNRNG: 48, EUNATCH: 49, ENOCSI: 50, EL2HLT: 51, EDEADLK: 35, ENOLCK: 37, EBADE: 52, EBADR: 53, EXFULL: 54, ENOANO: 55, EBADRQC: 56, EBADSLT: 57, EDEADLOCK: 35, EBFONT: 59, ENOSTR: 60, ENODATA: 61, ETIME: 62, ENOSR: 63, ENONET: 64, ENOPKG: 65, EREMOTE: 66, ENOLINK: 67, EADV: 68, ESRMNT: 69, ECOMM: 70, EPROTO: 71, EMULTIHOP: 72, EDOTDOT: 73, EBADMSG: 74, ENOTUNIQ: 76, EBADFD: 77, EREMCHG: 78, ELIBACC: 79, ELIBBAD: 80, ELIBSCN: 81, ELIBMAX: 82, ELIBEXEC: 83, ENOSYS: 38, ENOTEMPTY: 39, ENAMETOOLONG: 36, ELOOP: 40, EOPNOTSUPP: 95, EPFNOSUPPORT: 96, ECONNRESET: 104, ENOBUFS: 105, EAFNOSUPPORT: 97, EPROTOTYPE: 91, ENOTSOCK: 88, ENOPROTOOPT: 92, ESHUTDOWN: 108, ECONNREFUSED: 111, EADDRINUSE: 98, ECONNABORTED: 103, ENETUNREACH: 101, ENETDOWN: 100, ETIMEDOUT: 110, EHOSTDOWN: 112, EHOSTUNREACH: 113, EINPROGRESS: 115, EALREADY: 114, EDESTADDRREQ: 89, EMSGSIZE: 90, EPROTONOSUPPORT: 93, ESOCKTNOSUPPORT: 94, EADDRNOTAVAIL: 99, ENETRESET: 102, EISCONN: 106, ENOTCONN: 107, ETOOMANYREFS: 109, EUSERS: 87, EDQUOT: 122, ESTALE: 116, ENOTSUP: 95, ENOMEDIUM: 123, EILSEQ: 84, EOVERFLOW: 75, ECANCELED: 125, ENOTRECOVERABLE: 131, EOWNERDEAD: 130, ESTRPIPE: 86 };
var ERRNO_MESSAGES = { 0: "Success", 1: "Not super-user", 2: "No such file or directory", 3: "No such process", 4: "Interrupted system call", 5: "I/O error", 6: "No such device or address", 7: "Arg list too long", 8: "Exec format error", 9: "Bad file number", 10: "No children", 11: "No more processes", 12: "Not enough core", 13: "Permission denied", 14: "Bad address", 15: "Block device required", 16: "Mount device busy", 17: "File exists", 18: "Cross-device link", 19: "No such device", 20: "Not a directory", 21: "Is a directory", 22: "Invalid argument", 23: "Too many open files in system", 24: "Too many open files", 25: "Not a typewriter", 26: "Text file busy", 27: "File too large", 28: "No space left on device", 29: "Illegal seek", 30: "Read only file system", 31: "Too many links", 32: "Broken pipe", 33: "Math arg out of domain of func", 34: "Math result not representable", 35: "File locking deadlock error", 36: "File or path name too long", 37: "No record locks available", 38: "Function not implemented", 39: "Directory not empty", 40: "Too many symbolic links", 42: "No message of desired type", 43: "Identifier removed", 44: "Channel number out of range", 45: "Level 2 not synchronized", 46: "Level 3 halted", 47: "Level 3 reset", 48: "Link number out of range", 49: "Protocol driver not attached", 50: "No CSI structure available", 51: "Level 2 halted", 52: "Invalid exchange", 53: "Invalid request descriptor", 54: "Exchange full", 55: "No anode", 56: "Invalid request code", 57: "Invalid slot", 59: "Bad font file fmt", 60: "Device not a stream", 61: "No data (for no delay io)", 62: "Timer expired", 63: "Out of streams resources", 64: "Machine is not on the network", 65: "Package not installed", 66: "The object is remote", 67: "The link has been severed", 68: "Advertise error", 69: "Srmount error", 70: "Communication error on send", 71: "Protocol error", 72: "Multihop attempted", 73: "Cross mount point (not really error)", 74: "Trying to read unreadable message", 75: "Value too large for defined data type", 76: "Given log. name not unique", 77: "f.d. invalid for this operation", 78: "Remote address changed", 79: "Can   access a needed shared lib", 80: "Accessing a corrupted shared lib", 81: ".lib section in a.out corrupted", 82: "Attempting to link in too many libs", 83: "Attempting to exec a shared library", 84: "Illegal byte sequence", 86: "Streams pipe error", 87: "Too many users", 88: "Socket operation on non-socket", 89: "Destination address required", 90: "Message too long", 91: "Protocol wrong type for socket", 92: "Protocol not available", 93: "Unknown protocol", 94: "Socket type not supported", 95: "Not supported", 96: "Protocol family not supported", 97: "Address family not supported by protocol family", 98: "Address already in use", 99: "Address not available", 100: "Network interface is not configured", 101: "Network is unreachable", 102: "Connection reset by network", 103: "Connection aborted", 104: "Connection reset by peer", 105: "No buffer space available", 106: "Socket is already connected", 107: "Socket is not connected", 108: "Can't send after socket shutdown", 109: "Too many references", 110: "Connection timed out", 111: "Connection refused", 112: "Host is down", 113: "Host is unreachable", 114: "Socket already connected", 115: "Connection already in progress", 116: "Stale file handle", 122: "Quota exceeded", 123: "No medium (in tape drive)", 125: "Operation canceled", 130: "Previous owner died", 131: "State not recoverable" };

function ___setErrNo(value) { if (Module["___errno_location"]) HEAP32[Module["___errno_location"]() >> 2] = value; return value }
var PATH = {
    splitPath: (function(filename) { var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/; return splitPathRe.exec(filename).slice(1) }),
    normalizeArray: (function(parts, allowAboveRoot) {
        var up = 0;
        for (var i = parts.length - 1; i >= 0; i--) {
            var last = parts[i];
            if (last === ".") { parts.splice(i, 1) } else if (last === "..") {
                parts.splice(i, 1);
                up++
            } else if (up) {
                parts.splice(i, 1);
                up--
            }
        }
        if (allowAboveRoot) { for (; up; up--) { parts.unshift("..") } }
        return parts
    }),
    normalize: (function(path) {
        var isAbsolute = path.charAt(0) === "/",
            trailingSlash = path.substr(-1) === "/";
        path = PATH.normalizeArray(path.split("/").filter((function(p) { return !!p })), !isAbsolute).join("/");
        if (!path && !isAbsolute) { path = "." }
        if (path && trailingSlash) { path += "/" }
        return (isAbsolute ? "/" : "") + path
    }),
    dirname: (function(path) {
        var result = PATH.splitPath(path),
            root = result[0],
            dir = result[1];
        if (!root && !dir) { return "." }
        if (dir) { dir = dir.substr(0, dir.length - 1) }
        return root + dir
    }),
    basename: (function(path) { if (path === "/") return "/"; var lastSlash = path.lastIndexOf("/"); if (lastSlash === -1) return path; return path.substr(lastSlash + 1) }),
    extname: (function(path) { return PATH.splitPath(path)[3] }),
    join: (function() { var paths = Array.prototype.slice.call(arguments, 0); return PATH.normalize(paths.join("/")) }),
    join2: (function(l, r) { return PATH.normalize(l + "/" + r) }),
    resolve: (function() {
        var resolvedPath = "",
            resolvedAbsolute = false;
        for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
            var path = i >= 0 ? arguments[i] : FS.cwd();
            if (typeof path !== "string") { throw new TypeError("Arguments to path.resolve must be strings") } else if (!path) { return "" }
            resolvedPath = path + "/" + resolvedPath;
            resolvedAbsolute = path.charAt(0) === "/"
        }
        resolvedPath = PATH.normalizeArray(resolvedPath.split("/").filter((function(p) { return !!p })), !resolvedAbsolute).join("/");
        return (resolvedAbsolute ? "/" : "") + resolvedPath || "."
    }),
    relative: (function(from, to) {
        from = PATH.resolve(from).substr(1);
        to = PATH.resolve(to).substr(1);

        function trim(arr) { var start = 0; for (; start < arr.length; start++) { if (arr[start] !== "") break } var end = arr.length - 1; for (; end >= 0; end--) { if (arr[end] !== "") break } if (start > end) return []; return arr.slice(start, end - start + 1) }
        var fromParts = trim(from.split("/"));
        var toParts = trim(to.split("/"));
        var length = Math.min(fromParts.length, toParts.length);
        var samePartsLength = length;
        for (var i = 0; i < length; i++) { if (fromParts[i] !== toParts[i]) { samePartsLength = i; break } }
        var outputParts = [];
        for (var i = samePartsLength; i < fromParts.length; i++) { outputParts.push("..") }
        outputParts = outputParts.concat(toParts.slice(samePartsLength));
        return outputParts.join("/")
    })
};
var TTY = {
    ttys: [],
    init: (function() {}),
    shutdown: (function() {}),
    register: (function(dev, ops) {
        TTY.ttys[dev] = { input: [], output: [], ops: ops };
        FS.registerDevice(dev, TTY.stream_ops)
    }),
    stream_ops: {
        open: (function(stream) {
            var tty = TTY.ttys[stream.node.rdev];
            if (!tty) { throw new FS.ErrnoError(ERRNO_CODES.ENODEV) }
            stream.tty = tty;
            stream.seekable = false
        }),
        close: (function(stream) { stream.tty.ops.flush(stream.tty) }),
        flush: (function(stream) { stream.tty.ops.flush(stream.tty) }),
        read: (function(stream, buffer, offset, length, pos) {
            if (!stream.tty || !stream.tty.ops.get_char) { throw new FS.ErrnoError(ERRNO_CODES.ENXIO) }
            var bytesRead = 0;
            for (var i = 0; i < length; i++) {
                var result;
                try { result = stream.tty.ops.get_char(stream.tty) } catch (e) { throw new FS.ErrnoError(ERRNO_CODES.EIO) }
                if (result === undefined && bytesRead === 0) { throw new FS.ErrnoError(ERRNO_CODES.EAGAIN) }
                if (result === null || result === undefined) break;
                bytesRead++;
                buffer[offset + i] = result
            }
            if (bytesRead) { stream.node.timestamp = Date.now() }
            return bytesRead
        }),
        write: (function(stream, buffer, offset, length, pos) {
            if (!stream.tty || !stream.tty.ops.put_char) { throw new FS.ErrnoError(ERRNO_CODES.ENXIO) }
            var i = 0;
            try {
                if (offset === 0 && length === 0) { stream.tty.ops.flush(stream.tty) } else {
                    while (i < length) {
                        stream.tty.ops.put_char(stream.tty, buffer[offset + i]);
                        i++
                    }
                }
            } catch (e) { throw new FS.ErrnoError(ERRNO_CODES.EIO) }
            if (length) { stream.node.timestamp = Date.now() }
            return i
        })
    },
    default_tty_ops: {
        get_char: (function(tty) {
            if (!tty.input.length) {
                var result = null;
                if (ENVIRONMENT_IS_NODE) {
                    var BUFSIZE = 256;
                    var buf = new Buffer(BUFSIZE);
                    var bytesRead = 0;
                    var isPosixPlatform = process.platform != "win32";
                    var fd = process.stdin.fd;
                    if (isPosixPlatform) {
                        var usingDevice = false;
                        try {
                            fd = fs.openSync("/dev/stdin", "r");
                            usingDevice = true
                        } catch (e) {}
                    }
                    try { bytesRead = fs.readSync(fd, buf, 0, BUFSIZE, null) } catch (e) {
                        if (e.toString().indexOf("EOF") != -1) bytesRead = 0;
                        else throw e
                    }
                    if (usingDevice) { fs.closeSync(fd) }
                    if (bytesRead > 0) { result = buf.slice(0, bytesRead).toString("utf-8") } else { result = null }
                } else if (typeof window != "undefined" && typeof window.prompt == "function") { result = window.prompt("Input: "); if (result !== null) { result += "\n" } } else if (typeof readline == "function") { result = readline(); if (result !== null) { result += "\n" } }
                if (!result) { return null }
                tty.input = intArrayFromString(result, true)
            }
            return tty.input.shift()
        }),
        put_char: (function(tty, val) {
            if (val === null || val === 10) {
                out(UTF8ArrayToString(tty.output, 0));
                tty.output = []
            } else { if (val != 0) tty.output.push(val) }
        }),
        flush: (function(tty) {
            if (tty.output && tty.output.length > 0) {
                out(UTF8ArrayToString(tty.output, 0));
                tty.output = []
            }
        })
    },
    default_tty1_ops: {
        put_char: (function(tty, val) {
            if (val === null || val === 10) {
                err(UTF8ArrayToString(tty.output, 0));
                tty.output = []
            } else { if (val != 0) tty.output.push(val) }
        }),
        flush: (function(tty) {
            if (tty.output && tty.output.length > 0) {
                err(UTF8ArrayToString(tty.output, 0));
                tty.output = []
            }
        })
    }
};
var MEMFS = {
    ops_table: null,
    mount: (function(mount) { return MEMFS.createNode(null, "/", 16384 | 511, 0) }),
    createNode: (function(parent, name, mode, dev) {
        if (FS.isBlkdev(mode) || FS.isFIFO(mode)) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) }
        if (!MEMFS.ops_table) { MEMFS.ops_table = { dir: { node: { getattr: MEMFS.node_ops.getattr, setattr: MEMFS.node_ops.setattr, lookup: MEMFS.node_ops.lookup, mknod: MEMFS.node_ops.mknod, rename: MEMFS.node_ops.rename, unlink: MEMFS.node_ops.unlink, rmdir: MEMFS.node_ops.rmdir, readdir: MEMFS.node_ops.readdir, symlink: MEMFS.node_ops.symlink }, stream: { llseek: MEMFS.stream_ops.llseek } }, file: { node: { getattr: MEMFS.node_ops.getattr, setattr: MEMFS.node_ops.setattr }, stream: { llseek: MEMFS.stream_ops.llseek, read: MEMFS.stream_ops.read, write: MEMFS.stream_ops.write, allocate: MEMFS.stream_ops.allocate, mmap: MEMFS.stream_ops.mmap, msync: MEMFS.stream_ops.msync } }, link: { node: { getattr: MEMFS.node_ops.getattr, setattr: MEMFS.node_ops.setattr, readlink: MEMFS.node_ops.readlink }, stream: {} }, chrdev: { node: { getattr: MEMFS.node_ops.getattr, setattr: MEMFS.node_ops.setattr }, stream: FS.chrdev_stream_ops } } }
        var node = FS.createNode(parent, name, mode, dev);
        if (FS.isDir(node.mode)) {
            node.node_ops = MEMFS.ops_table.dir.node;
            node.stream_ops = MEMFS.ops_table.dir.stream;
            node.contents = {}
        } else if (FS.isFile(node.mode)) {
            node.node_ops = MEMFS.ops_table.file.node;
            node.stream_ops = MEMFS.ops_table.file.stream;
            node.usedBytes = 0;
            node.contents = null
        } else if (FS.isLink(node.mode)) {
            node.node_ops = MEMFS.ops_table.link.node;
            node.stream_ops = MEMFS.ops_table.link.stream
        } else if (FS.isChrdev(node.mode)) {
            node.node_ops = MEMFS.ops_table.chrdev.node;
            node.stream_ops = MEMFS.ops_table.chrdev.stream
        }
        node.timestamp = Date.now();
        if (parent) { parent.contents[name] = node }
        return node
    }),
    getFileDataAsRegularArray: (function(node) { if (node.contents && node.contents.subarray) { var arr = []; for (var i = 0; i < node.usedBytes; ++i) arr.push(node.contents[i]); return arr } return node.contents }),
    getFileDataAsTypedArray: (function(node) { if (!node.contents) return new Uint8Array; if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes); return new Uint8Array(node.contents) }),
    expandFileStorage: (function(node, newCapacity) {
        if (node.contents && node.contents.subarray && newCapacity > node.contents.length) {
            node.contents = MEMFS.getFileDataAsRegularArray(node);
            node.usedBytes = node.contents.length
        }
        if (!node.contents || node.contents.subarray) {
            var prevCapacity = node.contents ? node.contents.length : 0;
            if (prevCapacity >= newCapacity) return;
            var CAPACITY_DOUBLING_MAX = 1024 * 1024;
            newCapacity = Math.max(newCapacity, prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125) | 0);
            if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256);
            var oldContents = node.contents;
            node.contents = new Uint8Array(newCapacity);
            if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0);
            return
        }
        if (!node.contents && newCapacity > 0) node.contents = [];
        while (node.contents.length < newCapacity) node.contents.push(0)
    }),
    resizeFileStorage: (function(node, newSize) {
        if (node.usedBytes == newSize) return;
        if (newSize == 0) {
            node.contents = null;
            node.usedBytes = 0;
            return
        }
        if (!node.contents || node.contents.subarray) {
            var oldContents = node.contents;
            node.contents = new Uint8Array(new ArrayBuffer(newSize));
            if (oldContents) { node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes))) }
            node.usedBytes = newSize;
            return
        }
        if (!node.contents) node.contents = [];
        if (node.contents.length > newSize) node.contents.length = newSize;
        else
            while (node.contents.length < newSize) node.contents.push(0);
        node.usedBytes = newSize
    }),
    node_ops: {
        getattr: (function(node) {
            var attr = {};
            attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
            attr.ino = node.id;
            attr.mode = node.mode;
            attr.nlink = 1;
            attr.uid = 0;
            attr.gid = 0;
            attr.rdev = node.rdev;
            if (FS.isDir(node.mode)) { attr.size = 4096 } else if (FS.isFile(node.mode)) { attr.size = node.usedBytes } else if (FS.isLink(node.mode)) { attr.size = node.link.length } else { attr.size = 0 }
            attr.atime = new Date(node.timestamp);
            attr.mtime = new Date(node.timestamp);
            attr.ctime = new Date(node.timestamp);
            attr.blksize = 4096;
            attr.blocks = Math.ceil(attr.size / attr.blksize);
            return attr
        }),
        setattr: (function(node, attr) { if (attr.mode !== undefined) { node.mode = attr.mode } if (attr.timestamp !== undefined) { node.timestamp = attr.timestamp } if (attr.size !== undefined) { MEMFS.resizeFileStorage(node, attr.size) } }),
        lookup: (function(parent, name) { throw FS.genericErrors[ERRNO_CODES.ENOENT] }),
        mknod: (function(parent, name, mode, dev) { return MEMFS.createNode(parent, name, mode, dev) }),
        rename: (function(old_node, new_dir, new_name) {
            if (FS.isDir(old_node.mode)) { var new_node; try { new_node = FS.lookupNode(new_dir, new_name) } catch (e) {} if (new_node) { for (var i in new_node.contents) { throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY) } } }
            delete old_node.parent.contents[old_node.name];
            old_node.name = new_name;
            new_dir.contents[new_name] = old_node;
            old_node.parent = new_dir
        }),
        unlink: (function(parent, name) { delete parent.contents[name] }),
        rmdir: (function(parent, name) {
            var node = FS.lookupNode(parent, name);
            for (var i in node.contents) { throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY) }
            delete parent.contents[name]
        }),
        readdir: (function(node) {
            var entries = [".", ".."];
            for (var key in node.contents) {
                if (!node.contents.hasOwnProperty(key)) { continue }
                entries.push(key)
            }
            return entries
        }),
        symlink: (function(parent, newname, oldpath) {
            var node = MEMFS.createNode(parent, newname, 511 | 40960, 0);
            node.link = oldpath;
            return node
        }),
        readlink: (function(node) { if (!FS.isLink(node.mode)) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) } return node.link })
    },
    stream_ops: {
        read: (function(stream, buffer, offset, length, position) {
            var contents = stream.node.contents;
            if (position >= stream.node.usedBytes) return 0;
            var size = Math.min(stream.node.usedBytes - position, length);
            assert(size >= 0);
            if (size > 8 && contents.subarray) { buffer.set(contents.subarray(position, position + size), offset) } else { for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i] }
            return size
        }),
        write: (function(stream, buffer, offset, length, position, canOwn) {
            canOwn = false;
            if (!length) return 0;
            var node = stream.node;
            node.timestamp = Date.now();
            if (buffer.subarray && (!node.contents || node.contents.subarray)) {
                if (canOwn) {
                    node.contents = buffer.subarray(offset, offset + length);
                    node.usedBytes = length;
                    return length
                } else if (node.usedBytes === 0 && position === 0) {
                    node.contents = new Uint8Array(buffer.subarray(offset, offset + length));
                    node.usedBytes = length;
                    return length
                } else if (position + length <= node.usedBytes) { node.contents.set(buffer.subarray(offset, offset + length), position); return length }
            }
            MEMFS.expandFileStorage(node, position + length);
            if (node.contents.subarray && buffer.subarray) node.contents.set(buffer.subarray(offset, offset + length), position);
            else { for (var i = 0; i < length; i++) { node.contents[position + i] = buffer[offset + i] } }
            node.usedBytes = Math.max(node.usedBytes, position + length);
            return length
        }),
        llseek: (function(stream, offset, whence) { var position = offset; if (whence === 1) { position += stream.position } else if (whence === 2) { if (FS.isFile(stream.node.mode)) { position += stream.node.usedBytes } } if (position < 0) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) } return position }),
        allocate: (function(stream, offset, length) {
            MEMFS.expandFileStorage(stream.node, offset + length);
            stream.node.usedBytes = Math.max(stream.node.usedBytes, offset + length)
        }),
        mmap: (function(stream, buffer, offset, length, position, prot, flags) {
            if (!FS.isFile(stream.node.mode)) { throw new FS.ErrnoError(ERRNO_CODES.ENODEV) }
            var ptr;
            var allocated;
            var contents = stream.node.contents;
            if (!(flags & 2) && (contents.buffer === buffer || contents.buffer === buffer.buffer)) {
                allocated = false;
                ptr = contents.byteOffset
            } else {
                if (position > 0 || position + length < stream.node.usedBytes) { if (contents.subarray) { contents = contents.subarray(position, position + length) } else { contents = Array.prototype.slice.call(contents, position, position + length) } }
                allocated = true;
                ptr = _malloc(length);
                if (!ptr) { throw new FS.ErrnoError(ERRNO_CODES.ENOMEM) }
                buffer.set(contents, ptr)
            }
            return { ptr: ptr, allocated: allocated }
        }),
        msync: (function(stream, buffer, offset, length, mmapFlags) { if (!FS.isFile(stream.node.mode)) { throw new FS.ErrnoError(ERRNO_CODES.ENODEV) } if (mmapFlags & 2) { return 0 } var bytesWritten = MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false); return 0 })
    }
};
var IDBFS = {
    dbs: {},
    indexedDB: (function() {
        if (typeof indexedDB !== "undefined") return indexedDB;
        var ret = null;
        if (typeof window === "object") ret = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
        assert(ret, "IDBFS used, but indexedDB not supported");
        return ret
    }),
    DB_VERSION: 21,
    DB_STORE_NAME: "FILE_DATA",
    mount: (function(mount) { return MEMFS.mount.apply(null, arguments) }),
    syncfs: (function(mount, populate, callback) {
        IDBFS.getLocalSet(mount, (function(err, local) {
            if (err) return callback(err);
            IDBFS.getRemoteSet(mount, (function(err, remote) {
                if (err) return callback(err);
                var src = populate ? remote : local;
                var dst = populate ? local : remote;
                IDBFS.reconcile(src, dst, callback)
            }))
        }))
    }),
    getDB: (function(name, callback) {
        var db = IDBFS.dbs[name];
        if (db) { return callback(null, db) }
        var req;
        try { req = IDBFS.indexedDB().open(name, IDBFS.DB_VERSION) } catch (e) { return callback(e) }
        if (!req) { return callback("Unable to connect to IndexedDB") }
        req.onupgradeneeded = (function(e) { var db = e.target.result; var transaction = e.target.transaction; var fileStore; if (db.objectStoreNames.contains(IDBFS.DB_STORE_NAME)) { fileStore = transaction.objectStore(IDBFS.DB_STORE_NAME) } else { fileStore = db.createObjectStore(IDBFS.DB_STORE_NAME) } if (!fileStore.indexNames.contains("timestamp")) { fileStore.createIndex("timestamp", "timestamp", { unique: false }) } });
        req.onsuccess = (function() {
            db = req.result;
            IDBFS.dbs[name] = db;
            callback(null, db)
        });
        req.onerror = (function(e) {
            callback(this.error);
            e.preventDefault()
        })
    }),
    getLocalSet: (function(mount, callback) {
        var entries = {};

        function isRealDir(p) { return p !== "." && p !== ".." }

        function toAbsolute(root) { return (function(p) { return PATH.join2(root, p) }) }
        var check = FS.readdir(mount.mountpoint).filter(isRealDir).map(toAbsolute(mount.mountpoint));
        while (check.length) {
            var path = check.pop();
            var stat;
            try { stat = FS.stat(path) } catch (e) { return callback(e) }
            if (FS.isDir(stat.mode)) { check.push.apply(check, FS.readdir(path).filter(isRealDir).map(toAbsolute(path))) }
            entries[path] = { timestamp: stat.mtime }
        }
        return callback(null, { type: "local", entries: entries })
    }),
    getRemoteSet: (function(mount, callback) {
        var entries = {};
        IDBFS.getDB(mount.mountpoint, (function(err, db) {
            if (err) return callback(err);
            try {
                var transaction = db.transaction([IDBFS.DB_STORE_NAME], "readonly");
                transaction.onerror = (function(e) {
                    callback(this.error);
                    e.preventDefault()
                });
                var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
                var index = store.index("timestamp");
                index.openKeyCursor().onsuccess = (function(event) {
                    var cursor = event.target.result;
                    if (!cursor) { return callback(null, { type: "remote", db: db, entries: entries }) }
                    entries[cursor.primaryKey] = { timestamp: cursor.key };
                    cursor.continue()
                })
            } catch (e) { return callback(e) }
        }))
    }),
    loadLocalEntry: (function(path, callback) {
        var stat, node;
        try {
            var lookup = FS.lookupPath(path);
            node = lookup.node;
            stat = FS.stat(path)
        } catch (e) { return callback(e) }
        if (FS.isDir(stat.mode)) { return callback(null, { timestamp: stat.mtime, mode: stat.mode }) } else if (FS.isFile(stat.mode)) { node.contents = MEMFS.getFileDataAsTypedArray(node); return callback(null, { timestamp: stat.mtime, mode: stat.mode, contents: node.contents }) } else { return callback(new Error("node type not supported")) }
    }),
    storeLocalEntry: (function(path, entry, callback) {
        try {
            if (FS.isDir(entry.mode)) { FS.mkdir(path, entry.mode) } else if (FS.isFile(entry.mode)) { FS.writeFile(path, entry.contents, { canOwn: true }) } else { return callback(new Error("node type not supported")) }
            FS.chmod(path, entry.mode);
            FS.utime(path, entry.timestamp, entry.timestamp)
        } catch (e) { return callback(e) }
        callback(null)
    }),
    removeLocalEntry: (function(path, callback) {
        try { var lookup = FS.lookupPath(path); var stat = FS.stat(path); if (FS.isDir(stat.mode)) { FS.rmdir(path) } else if (FS.isFile(stat.mode)) { FS.unlink(path) } } catch (e) { return callback(e) }
        callback(null)
    }),
    loadRemoteEntry: (function(store, path, callback) {
        var req = store.get(path);
        req.onsuccess = (function(event) { callback(null, event.target.result) });
        req.onerror = (function(e) {
            callback(this.error);
            e.preventDefault()
        })
    }),
    storeRemoteEntry: (function(store, path, entry, callback) {
        var req = store.put(entry, path);
        req.onsuccess = (function() { callback(null) });
        req.onerror = (function(e) {
            callback(this.error);
            e.preventDefault()
        })
    }),
    removeRemoteEntry: (function(store, path, callback) {
        var req = store.delete(path);
        req.onsuccess = (function() { callback(null) });
        req.onerror = (function(e) {
            callback(this.error);
            e.preventDefault()
        })
    }),
    reconcile: (function(src, dst, callback) {
        var total = 0;
        var create = [];
        Object.keys(src.entries).forEach((function(key) {
            var e = src.entries[key];
            var e2 = dst.entries[key];
            if (!e2 || e.timestamp > e2.timestamp) {
                create.push(key);
                total++
            }
        }));
        var remove = [];
        Object.keys(dst.entries).forEach((function(key) {
            var e = dst.entries[key];
            var e2 = src.entries[key];
            if (!e2) {
                remove.push(key);
                total++
            }
        }));
        if (!total) { return callback(null) }
        var completed = 0;
        var db = src.type === "remote" ? src.db : dst.db;
        var transaction = db.transaction([IDBFS.DB_STORE_NAME], "readwrite");
        var store = transaction.objectStore(IDBFS.DB_STORE_NAME);

        function done(err) { if (err) { if (!done.errored) { done.errored = true; return callback(err) } return } if (++completed >= total) { return callback(null) } }
        transaction.onerror = (function(e) {
            done(this.error);
            e.preventDefault()
        });
        create.sort().forEach((function(path) {
            if (dst.type === "local") {
                IDBFS.loadRemoteEntry(store, path, (function(err, entry) {
                    if (err) return done(err);
                    IDBFS.storeLocalEntry(path, entry, done)
                }))
            } else {
                IDBFS.loadLocalEntry(path, (function(err, entry) {
                    if (err) return done(err);
                    IDBFS.storeRemoteEntry(store, path, entry, done)
                }))
            }
        }));
        remove.sort().reverse().forEach((function(path) { if (dst.type === "local") { IDBFS.removeLocalEntry(path, done) } else { IDBFS.removeRemoteEntry(store, path, done) } }))
    })
};
var NODEFS = {
    isWindows: false,
    staticInit: (function() {
        NODEFS.isWindows = !!process.platform.match(/^win/);
        var flags = process["binding"]("constants");
        if (flags["fs"]) { flags = flags["fs"] }
        NODEFS.flagsForNodeMap = { "1024": flags["O_APPEND"], "64": flags["O_CREAT"], "128": flags["O_EXCL"], "0": flags["O_RDONLY"], "2": flags["O_RDWR"], "4096": flags["O_SYNC"], "512": flags["O_TRUNC"], "1": flags["O_WRONLY"] }
    }),
    bufferFrom: (function(arrayBuffer) { return Buffer.alloc ? Buffer.from(arrayBuffer) : new Buffer(arrayBuffer) }),
    mount: (function(mount) { assert(ENVIRONMENT_IS_NODE); return NODEFS.createNode(null, "/", NODEFS.getMode(mount.opts.root), 0) }),
    createNode: (function(parent, name, mode, dev) {
        if (!FS.isDir(mode) && !FS.isFile(mode) && !FS.isLink(mode)) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) }
        var node = FS.createNode(parent, name, mode);
        node.node_ops = NODEFS.node_ops;
        node.stream_ops = NODEFS.stream_ops;
        return node
    }),
    getMode: (function(path) { var stat; try { stat = fs.lstatSync(path); if (NODEFS.isWindows) { stat.mode = stat.mode | (stat.mode & 292) >> 2 } } catch (e) { if (!e.code) throw e; throw new FS.ErrnoError(ERRNO_CODES[e.code]) } return stat.mode }),
    realPath: (function(node) {
        var parts = [];
        while (node.parent !== node) {
            parts.push(node.name);
            node = node.parent
        }
        parts.push(node.mount.opts.root);
        parts.reverse();
        return PATH.join.apply(null, parts)
    }),
    flagsForNode: (function(flags) {
        flags &= ~2097152;
        flags &= ~2048;
        flags &= ~32768;
        flags &= ~524288;
        var newFlags = 0;
        for (var k in NODEFS.flagsForNodeMap) {
            if (flags & k) {
                newFlags |= NODEFS.flagsForNodeMap[k];
                flags ^= k
            }
        }
        if (!flags) { return newFlags } else { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) }
    }),
    node_ops: {
        getattr: (function(node) { var path = NODEFS.realPath(node); var stat; try { stat = fs.lstatSync(path) } catch (e) { if (!e.code) throw e; throw new FS.ErrnoError(ERRNO_CODES[e.code]) } if (NODEFS.isWindows && !stat.blksize) { stat.blksize = 4096 } if (NODEFS.isWindows && !stat.blocks) { stat.blocks = (stat.size + stat.blksize - 1) / stat.blksize | 0 } return { dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, uid: stat.uid, gid: stat.gid, rdev: stat.rdev, size: stat.size, atime: stat.atime, mtime: stat.mtime, ctime: stat.ctime, blksize: stat.blksize, blocks: stat.blocks } }),
        setattr: (function(node, attr) {
            var path = NODEFS.realPath(node);
            try {
                if (attr.mode !== undefined) {
                    fs.chmodSync(path, attr.mode);
                    node.mode = attr.mode
                }
                if (attr.timestamp !== undefined) {
                    var date = new Date(attr.timestamp);
                    fs.utimesSync(path, date, date)
                }
                if (attr.size !== undefined) { fs.truncateSync(path, attr.size) }
            } catch (e) { if (!e.code) throw e; throw new FS.ErrnoError(ERRNO_CODES[e.code]) }
        }),
        lookup: (function(parent, name) { var path = PATH.join2(NODEFS.realPath(parent), name); var mode = NODEFS.getMode(path); return NODEFS.createNode(parent, name, mode) }),
        mknod: (function(parent, name, mode, dev) { var node = NODEFS.createNode(parent, name, mode, dev); var path = NODEFS.realPath(node); try { if (FS.isDir(node.mode)) { fs.mkdirSync(path, node.mode) } else { fs.writeFileSync(path, "", { mode: node.mode }) } } catch (e) { if (!e.code) throw e; throw new FS.ErrnoError(ERRNO_CODES[e.code]) } return node }),
        rename: (function(oldNode, newDir, newName) { var oldPath = NODEFS.realPath(oldNode); var newPath = PATH.join2(NODEFS.realPath(newDir), newName); try { fs.renameSync(oldPath, newPath) } catch (e) { if (!e.code) throw e; throw new FS.ErrnoError(ERRNO_CODES[e.code]) } }),
        unlink: (function(parent, name) { var path = PATH.join2(NODEFS.realPath(parent), name); try { fs.unlinkSync(path) } catch (e) { if (!e.code) throw e; throw new FS.ErrnoError(ERRNO_CODES[e.code]) } }),
        rmdir: (function(parent, name) { var path = PATH.join2(NODEFS.realPath(parent), name); try { fs.rmdirSync(path) } catch (e) { if (!e.code) throw e; throw new FS.ErrnoError(ERRNO_CODES[e.code]) } }),
        readdir: (function(node) { var path = NODEFS.realPath(node); try { return fs.readdirSync(path) } catch (e) { if (!e.code) throw e; throw new FS.ErrnoError(ERRNO_CODES[e.code]) } }),
        symlink: (function(parent, newName, oldPath) { var newPath = PATH.join2(NODEFS.realPath(parent), newName); try { fs.symlinkSync(oldPath, newPath) } catch (e) { if (!e.code) throw e; throw new FS.ErrnoError(ERRNO_CODES[e.code]) } }),
        readlink: (function(node) {
            var path = NODEFS.realPath(node);
            try {
                path = fs.readlinkSync(path);
                path = NODEJS_PATH.relative(NODEJS_PATH.resolve(node.mount.opts.root), path);
                return path
            } catch (e) { if (!e.code) throw e; throw new FS.ErrnoError(ERRNO_CODES[e.code]) }
        })
    },
    stream_ops: {
        open: (function(stream) { var path = NODEFS.realPath(stream.node); try { if (FS.isFile(stream.node.mode)) { stream.nfd = fs.openSync(path, NODEFS.flagsForNode(stream.flags)) } } catch (e) { if (!e.code) throw e; throw new FS.ErrnoError(ERRNO_CODES[e.code]) } }),
        close: (function(stream) { try { if (FS.isFile(stream.node.mode) && stream.nfd) { fs.closeSync(stream.nfd) } } catch (e) { if (!e.code) throw e; throw new FS.ErrnoError(ERRNO_CODES[e.code]) } }),
        read: (function(stream, buffer, offset, length, position) { if (length === 0) return 0; try { return fs.readSync(stream.nfd, NODEFS.bufferFrom(buffer.buffer), offset, length, position) } catch (e) { throw new FS.ErrnoError(ERRNO_CODES[e.code]) } }),
        write: (function(stream, buffer, offset, length, position) { try { return fs.writeSync(stream.nfd, NODEFS.bufferFrom(buffer.buffer), offset, length, position) } catch (e) { throw new FS.ErrnoError(ERRNO_CODES[e.code]) } }),
        llseek: (function(stream, offset, whence) {
            var position = offset;
            if (whence === 1) { position += stream.position } else if (whence === 2) {
                if (FS.isFile(stream.node.mode)) {
                    try {
                        var stat = fs.fstatSync(stream.nfd);
                        position += stat.size
                    } catch (e) { throw new FS.ErrnoError(ERRNO_CODES[e.code]) }
                }
            }
            if (position < 0) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) }
            return position
        })
    }
};
var WORKERFS = {
    DIR_MODE: 16895,
    FILE_MODE: 33279,
    reader: null,
    mount: (function(mount) {
        assert(ENVIRONMENT_IS_WORKER);
        if (!WORKERFS.reader) WORKERFS.reader = new FileReaderSync;
        var root = WORKERFS.createNode(null, "/", WORKERFS.DIR_MODE, 0);
        var createdParents = {};

        function ensureParent(path) {
            var parts = path.split("/");
            var parent = root;
            for (var i = 0; i < parts.length - 1; i++) {
                var curr = parts.slice(0, i + 1).join("/");
                if (!createdParents[curr]) { createdParents[curr] = WORKERFS.createNode(parent, parts[i], WORKERFS.DIR_MODE, 0) }
                parent = createdParents[curr]
            }
            return parent
        }

        function base(path) { var parts = path.split("/"); return parts[parts.length - 1] }
        Array.prototype.forEach.call(mount.opts["files"] || [], (function(file) { WORKERFS.createNode(ensureParent(file.name), base(file.name), WORKERFS.FILE_MODE, 0, file, file.lastModifiedDate) }));
        (mount.opts["blobs"] || []).forEach((function(obj) { WORKERFS.createNode(ensureParent(obj["name"]), base(obj["name"]), WORKERFS.FILE_MODE, 0, obj["data"]) }));
        (mount.opts["packages"] || []).forEach((function(pack) {
            pack["metadata"].files.forEach((function(file) {
                var name = file.filename.substr(1);
                WORKERFS.createNode(ensureParent(name), base(name), WORKERFS.FILE_MODE, 0, pack["blob"].slice(file.start, file.end))
            }))
        }));
        return root
    }),
    createNode: (function(parent, name, mode, dev, contents, mtime) {
        var node = FS.createNode(parent, name, mode);
        node.mode = mode;
        node.node_ops = WORKERFS.node_ops;
        node.stream_ops = WORKERFS.stream_ops;
        node.timestamp = (mtime || new Date).getTime();
        assert(WORKERFS.FILE_MODE !== WORKERFS.DIR_MODE);
        if (mode === WORKERFS.FILE_MODE) {
            node.size = contents.size;
            node.contents = contents
        } else {
            node.size = 4096;
            node.contents = {}
        }
        if (parent) { parent.contents[name] = node }
        return node
    }),
    node_ops: {
        getattr: (function(node) { return { dev: 1, ino: undefined, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: undefined, size: node.size, atime: new Date(node.timestamp), mtime: new Date(node.timestamp), ctime: new Date(node.timestamp), blksize: 4096, blocks: Math.ceil(node.size / 4096) } }),
        setattr: (function(node, attr) { if (attr.mode !== undefined) { node.mode = attr.mode } if (attr.timestamp !== undefined) { node.timestamp = attr.timestamp } }),
        lookup: (function(parent, name) { throw new FS.ErrnoError(ERRNO_CODES.ENOENT) }),
        mknod: (function(parent, name, mode, dev) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) }),
        rename: (function(oldNode, newDir, newName) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) }),
        unlink: (function(parent, name) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) }),
        rmdir: (function(parent, name) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) }),
        readdir: (function(node) {
            var entries = [".", ".."];
            for (var key in node.contents) {
                if (!node.contents.hasOwnProperty(key)) { continue }
                entries.push(key)
            }
            return entries
        }),
        symlink: (function(parent, newName, oldPath) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) }),
        readlink: (function(node) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) })
    },
    stream_ops: {
        read: (function(stream, buffer, offset, length, position) {
            if (position >= stream.node.size) return 0;
            var chunk = stream.node.contents.slice(position, position + length);
            var ab = WORKERFS.reader.readAsArrayBuffer(chunk);
            buffer.set(new Uint8Array(ab), offset);
            return chunk.size
        }),
        write: (function(stream, buffer, offset, length, position) { throw new FS.ErrnoError(ERRNO_CODES.EIO) }),
        llseek: (function(stream, offset, whence) { var position = offset; if (whence === 1) { position += stream.position } else if (whence === 2) { if (FS.isFile(stream.node.mode)) { position += stream.node.size } } if (position < 0) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) } return position })
    }
};
STATICTOP += 16;
STATICTOP += 16;
STATICTOP += 16;
var FS = {
    root: null,
    mounts: [],
    devices: {},
    streams: [],
    nextInode: 1,
    nameTable: null,
    currentPath: "/",
    initialized: false,
    ignorePermissions: true,
    trackingDelegate: {},
    tracking: { openFlags: { READ: 1, WRITE: 2 } },
    ErrnoError: null,
    genericErrors: {},
    filesystems: null,
    syncFSRequests: 0,
    handleFSError: (function(e) { if (!(e instanceof FS.ErrnoError)) throw e + " : " + stackTrace(); return ___setErrNo(e.errno) }),
    lookupPath: (function(path, opts) {
        path = PATH.resolve(FS.cwd(), path);
        opts = opts || {};
        if (!path) return { path: "", node: null };
        var defaults = { follow_mount: true, recurse_count: 0 };
        for (var key in defaults) { if (opts[key] === undefined) { opts[key] = defaults[key] } }
        if (opts.recurse_count > 8) { throw new FS.ErrnoError(ERRNO_CODES.ELOOP) }
        var parts = PATH.normalizeArray(path.split("/").filter((function(p) { return !!p })), false);
        var current = FS.root;
        var current_path = "/";
        for (var i = 0; i < parts.length; i++) {
            var islast = i === parts.length - 1;
            if (islast && opts.parent) { break }
            current = FS.lookupNode(current, parts[i]);
            current_path = PATH.join2(current_path, parts[i]);
            if (FS.isMountpoint(current)) { if (!islast || islast && opts.follow_mount) { current = current.mounted.root } }
            if (!islast || opts.follow) {
                var count = 0;
                while (FS.isLink(current.mode)) {
                    var link = FS.readlink(current_path);
                    current_path = PATH.resolve(PATH.dirname(current_path), link);
                    var lookup = FS.lookupPath(current_path, { recurse_count: opts.recurse_count });
                    current = lookup.node;
                    if (count++ > 40) { throw new FS.ErrnoError(ERRNO_CODES.ELOOP) }
                }
            }
        }
        return { path: current_path, node: current }
    }),
    getPath: (function(node) {
        var path;
        while (true) {
            if (FS.isRoot(node)) { var mount = node.mount.mountpoint; if (!path) return mount; return mount[mount.length - 1] !== "/" ? mount + "/" + path : mount + path }
            path = path ? node.name + "/" + path : node.name;
            node = node.parent
        }
    }),
    hashName: (function(parentid, name) { var hash = 0; for (var i = 0; i < name.length; i++) { hash = (hash << 5) - hash + name.charCodeAt(i) | 0 } return (parentid + hash >>> 0) % FS.nameTable.length }),
    hashAddNode: (function(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        node.name_next = FS.nameTable[hash];
        FS.nameTable[hash] = node
    }),
    hashRemoveNode: (function(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        if (FS.nameTable[hash] === node) { FS.nameTable[hash] = node.name_next } else {
            var current = FS.nameTable[hash];
            while (current) {
                if (current.name_next === node) { current.name_next = node.name_next; break }
                current = current.name_next
            }
        }
    }),
    lookupNode: (function(parent, name) { var err = FS.mayLookup(parent); if (err) { throw new FS.ErrnoError(err, parent) } var hash = FS.hashName(parent.id, name); for (var node = FS.nameTable[hash]; node; node = node.name_next) { var nodeName = node.name; if (node.parent.id === parent.id && nodeName === name) { return node } } return FS.lookup(parent, name) }),
    createNode: (function(parent, name, mode, rdev) {
        if (!FS.FSNode) {
            FS.FSNode = (function(parent, name, mode, rdev) {
                if (!parent) { parent = this }
                this.parent = parent;
                this.mount = parent.mount;
                this.mounted = null;
                this.id = FS.nextInode++;
                this.name = name;
                this.mode = mode;
                this.node_ops = {};
                this.stream_ops = {};
                this.rdev = rdev
            });
            FS.FSNode.prototype = {};
            var readMode = 292 | 73;
            var writeMode = 146;
            Object.defineProperties(FS.FSNode.prototype, { read: { get: (function() { return (this.mode & readMode) === readMode }), set: (function(val) { val ? this.mode |= readMode : this.mode &= ~readMode }) }, write: { get: (function() { return (this.mode & writeMode) === writeMode }), set: (function(val) { val ? this.mode |= writeMode : this.mode &= ~writeMode }) }, isFolder: { get: (function() { return FS.isDir(this.mode) }) }, isDevice: { get: (function() { return FS.isChrdev(this.mode) }) } })
        }
        var node = new FS.FSNode(parent, name, mode, rdev);
        FS.hashAddNode(node);
        return node
    }),
    destroyNode: (function(node) { FS.hashRemoveNode(node) }),
    isRoot: (function(node) { return node === node.parent }),
    isMountpoint: (function(node) { return !!node.mounted }),
    isFile: (function(mode) { return (mode & 61440) === 32768 }),
    isDir: (function(mode) { return (mode & 61440) === 16384 }),
    isLink: (function(mode) { return (mode & 61440) === 40960 }),
    isChrdev: (function(mode) { return (mode & 61440) === 8192 }),
    isBlkdev: (function(mode) { return (mode & 61440) === 24576 }),
    isFIFO: (function(mode) { return (mode & 61440) === 4096 }),
    isSocket: (function(mode) { return (mode & 49152) === 49152 }),
    flagModes: { "r": 0, "rs": 1052672, "r+": 2, "w": 577, "wx": 705, "xw": 705, "w+": 578, "wx+": 706, "xw+": 706, "a": 1089, "ax": 1217, "xa": 1217, "a+": 1090, "ax+": 1218, "xa+": 1218 },
    modeStringToFlags: (function(str) { var flags = FS.flagModes[str]; if (typeof flags === "undefined") { throw new Error("Unknown file open mode: " + str) } return flags }),
    flagsToPermissionString: (function(flag) { var perms = ["r", "w", "rw"][flag & 3]; if (flag & 512) { perms += "w" } return perms }),
    nodePermissions: (function(node, perms) { if (FS.ignorePermissions) { return 0 } if (perms.indexOf("r") !== -1 && !(node.mode & 292)) { return ERRNO_CODES.EACCES } else if (perms.indexOf("w") !== -1 && !(node.mode & 146)) { return ERRNO_CODES.EACCES } else if (perms.indexOf("x") !== -1 && !(node.mode & 73)) { return ERRNO_CODES.EACCES } return 0 }),
    mayLookup: (function(dir) { var err = FS.nodePermissions(dir, "x"); if (err) return err; if (!dir.node_ops.lookup) return ERRNO_CODES.EACCES; return 0 }),
    mayCreate: (function(dir, name) { try { var node = FS.lookupNode(dir, name); return ERRNO_CODES.EEXIST } catch (e) {} return FS.nodePermissions(dir, "wx") }),
    mayDelete: (function(dir, name, isdir) { var node; try { node = FS.lookupNode(dir, name) } catch (e) { return e.errno } var err = FS.nodePermissions(dir, "wx"); if (err) { return err } if (isdir) { if (!FS.isDir(node.mode)) { return ERRNO_CODES.ENOTDIR } if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) { return ERRNO_CODES.EBUSY } } else { if (FS.isDir(node.mode)) { return ERRNO_CODES.EISDIR } } return 0 }),
    mayOpen: (function(node, flags) { if (!node) { return ERRNO_CODES.ENOENT } if (FS.isLink(node.mode)) { return ERRNO_CODES.ELOOP } else if (FS.isDir(node.mode)) { if (FS.flagsToPermissionString(flags) !== "r" || flags & 512) { return ERRNO_CODES.EISDIR } } return FS.nodePermissions(node, FS.flagsToPermissionString(flags)) }),
    MAX_OPEN_FDS: 4096,
    nextfd: (function(fd_start, fd_end) {
        fd_start = fd_start || 0;
        fd_end = fd_end || FS.MAX_OPEN_FDS;
        for (var fd = fd_start; fd <= fd_end; fd++) { if (!FS.streams[fd]) { return fd } }
        throw new FS.ErrnoError(ERRNO_CODES.EMFILE)
    }),
    getStream: (function(fd) { return FS.streams[fd] }),
    createStream: (function(stream, fd_start, fd_end) {
        if (!FS.FSStream) {
            FS.FSStream = (function() {});
            FS.FSStream.prototype = {};
            Object.defineProperties(FS.FSStream.prototype, { object: { get: (function() { return this.node }), set: (function(val) { this.node = val }) }, isRead: { get: (function() { return (this.flags & 2097155) !== 1 }) }, isWrite: { get: (function() { return (this.flags & 2097155) !== 0 }) }, isAppend: { get: (function() { return this.flags & 1024 }) } })
        }
        var newStream = new FS.FSStream;
        for (var p in stream) { newStream[p] = stream[p] }
        stream = newStream;
        var fd = FS.nextfd(fd_start, fd_end);
        stream.fd = fd;
        FS.streams[fd] = stream;
        return stream
    }),
    closeStream: (function(fd) { FS.streams[fd] = null }),
    chrdev_stream_ops: {
        open: (function(stream) {
            var device = FS.getDevice(stream.node.rdev);
            stream.stream_ops = device.stream_ops;
            if (stream.stream_ops.open) { stream.stream_ops.open(stream) }
        }),
        llseek: (function() { throw new FS.ErrnoError(ERRNO_CODES.ESPIPE) })
    },
    major: (function(dev) { return dev >> 8 }),
    minor: (function(dev) { return dev & 255 }),
    makedev: (function(ma, mi) { return ma << 8 | mi }),
    registerDevice: (function(dev, ops) { FS.devices[dev] = { stream_ops: ops } }),
    getDevice: (function(dev) { return FS.devices[dev] }),
    getMounts: (function(mount) {
        var mounts = [];
        var check = [mount];
        while (check.length) {
            var m = check.pop();
            mounts.push(m);
            check.push.apply(check, m.mounts)
        }
        return mounts
    }),
    syncfs: (function(populate, callback) {
        if (typeof populate === "function") {
            callback = populate;
            populate = false
        }
        FS.syncFSRequests++;
        if (FS.syncFSRequests > 1) { console.log("warning: " + FS.syncFSRequests + " FS.syncfs operations in flight at once, probably just doing extra work") }
        var mounts = FS.getMounts(FS.root.mount);
        var completed = 0;

        function doCallback(err) {
            assert(FS.syncFSRequests > 0);
            FS.syncFSRequests--;
            return callback(err)
        }

        function done(err) { if (err) { if (!done.errored) { done.errored = true; return doCallback(err) } return } if (++completed >= mounts.length) { doCallback(null) } }
        mounts.forEach((function(mount) {
            if (!mount.type.syncfs) { return done(null) }
            mount.type.syncfs(mount, populate, done)
        }))
    }),
    mount: (function(type, opts, mountpoint) {
        var root = mountpoint === "/";
        var pseudo = !mountpoint;
        var node;
        if (root && FS.root) { throw new FS.ErrnoError(ERRNO_CODES.EBUSY) } else if (!root && !pseudo) {
            var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
            mountpoint = lookup.path;
            node = lookup.node;
            if (FS.isMountpoint(node)) { throw new FS.ErrnoError(ERRNO_CODES.EBUSY) }
            if (!FS.isDir(node.mode)) { throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR) }
        }
        var mount = { type: type, opts: opts, mountpoint: mountpoint, mounts: [] };
        var mountRoot = type.mount(mount);
        mountRoot.mount = mount;
        mount.root = mountRoot;
        if (root) { FS.root = mountRoot } else if (node) { node.mounted = mount; if (node.mount) { node.mount.mounts.push(mount) } }
        return mountRoot
    }),
    unmount: (function(mountpoint) {
        var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
        if (!FS.isMountpoint(lookup.node)) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) }
        var node = lookup.node;
        var mount = node.mounted;
        var mounts = FS.getMounts(mount);
        Object.keys(FS.nameTable).forEach((function(hash) {
            var current = FS.nameTable[hash];
            while (current) {
                var next = current.name_next;
                if (mounts.indexOf(current.mount) !== -1) { FS.destroyNode(current) }
                current = next
            }
        }));
        node.mounted = null;
        var idx = node.mount.mounts.indexOf(mount);
        assert(idx !== -1);
        node.mount.mounts.splice(idx, 1)
    }),
    lookup: (function(parent, name) { return parent.node_ops.lookup(parent, name) }),
    mknod: (function(path, mode, dev) { var lookup = FS.lookupPath(path, { parent: true }); var parent = lookup.node; var name = PATH.basename(path); if (!name || name === "." || name === "..") { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) } var err = FS.mayCreate(parent, name); if (err) { throw new FS.ErrnoError(err) } if (!parent.node_ops.mknod) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) } return parent.node_ops.mknod(parent, name, mode, dev) }),
    create: (function(path, mode) {
        mode = mode !== undefined ? mode : 438;
        mode &= 4095;
        mode |= 32768;
        return FS.mknod(path, mode, 0)
    }),
    mkdir: (function(path, mode) {
        mode = mode !== undefined ? mode : 511;
        mode &= 511 | 512;
        mode |= 16384;
        return FS.mknod(path, mode, 0)
    }),
    mkdirTree: (function(path, mode) {
        var dirs = path.split("/");
        var d = "";
        for (var i = 0; i < dirs.length; ++i) {
            if (!dirs[i]) continue;
            d += "/" + dirs[i];
            try { FS.mkdir(d, mode) } catch (e) { if (e.errno != ERRNO_CODES.EEXIST) throw e }
        }
    }),
    mkdev: (function(path, mode, dev) {
        if (typeof dev === "undefined") {
            dev = mode;
            mode = 438
        }
        mode |= 8192;
        return FS.mknod(path, mode, dev)
    }),
    symlink: (function(oldpath, newpath) { if (!PATH.resolve(oldpath)) { throw new FS.ErrnoError(ERRNO_CODES.ENOENT) } var lookup = FS.lookupPath(newpath, { parent: true }); var parent = lookup.node; if (!parent) { throw new FS.ErrnoError(ERRNO_CODES.ENOENT) } var newname = PATH.basename(newpath); var err = FS.mayCreate(parent, newname); if (err) { throw new FS.ErrnoError(err) } if (!parent.node_ops.symlink) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) } return parent.node_ops.symlink(parent, newname, oldpath) }),
    rename: (function(old_path, new_path) {
        var old_dirname = PATH.dirname(old_path);
        var new_dirname = PATH.dirname(new_path);
        var old_name = PATH.basename(old_path);
        var new_name = PATH.basename(new_path);
        var lookup, old_dir, new_dir;
        try {
            lookup = FS.lookupPath(old_path, { parent: true });
            old_dir = lookup.node;
            lookup = FS.lookupPath(new_path, { parent: true });
            new_dir = lookup.node
        } catch (e) { throw new FS.ErrnoError(ERRNO_CODES.EBUSY) }
        if (!old_dir || !new_dir) throw new FS.ErrnoError(ERRNO_CODES.ENOENT);
        if (old_dir.mount !== new_dir.mount) { throw new FS.ErrnoError(ERRNO_CODES.EXDEV) }
        var old_node = FS.lookupNode(old_dir, old_name);
        var relative = PATH.relative(old_path, new_dirname);
        if (relative.charAt(0) !== ".") { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) }
        relative = PATH.relative(new_path, old_dirname);
        if (relative.charAt(0) !== ".") { throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY) }
        var new_node;
        try { new_node = FS.lookupNode(new_dir, new_name) } catch (e) {}
        if (old_node === new_node) { return }
        var isdir = FS.isDir(old_node.mode);
        var err = FS.mayDelete(old_dir, old_name, isdir);
        if (err) { throw new FS.ErrnoError(err) }
        err = new_node ? FS.mayDelete(new_dir, new_name, isdir) : FS.mayCreate(new_dir, new_name);
        if (err) { throw new FS.ErrnoError(err) }
        if (!old_dir.node_ops.rename) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) }
        if (FS.isMountpoint(old_node) || new_node && FS.isMountpoint(new_node)) { throw new FS.ErrnoError(ERRNO_CODES.EBUSY) }
        if (new_dir !== old_dir) { err = FS.nodePermissions(old_dir, "w"); if (err) { throw new FS.ErrnoError(err) } }
        try { if (FS.trackingDelegate["willMovePath"]) { FS.trackingDelegate["willMovePath"](old_path, new_path) } } catch (e) { console.log("FS.trackingDelegate['willMovePath']('" + old_path + "', '" + new_path + "') threw an exception: " + e.message) }
        FS.hashRemoveNode(old_node);
        try { old_dir.node_ops.rename(old_node, new_dir, new_name) } catch (e) { throw e } finally { FS.hashAddNode(old_node) }
        try { if (FS.trackingDelegate["onMovePath"]) FS.trackingDelegate["onMovePath"](old_path, new_path) } catch (e) { console.log("FS.trackingDelegate['onMovePath']('" + old_path + "', '" + new_path + "') threw an exception: " + e.message) }
    }),
    rmdir: (function(path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var err = FS.mayDelete(parent, name, true);
        if (err) { throw new FS.ErrnoError(err) }
        if (!parent.node_ops.rmdir) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) }
        if (FS.isMountpoint(node)) { throw new FS.ErrnoError(ERRNO_CODES.EBUSY) }
        try { if (FS.trackingDelegate["willDeletePath"]) { FS.trackingDelegate["willDeletePath"](path) } } catch (e) { console.log("FS.trackingDelegate['willDeletePath']('" + path + "') threw an exception: " + e.message) }
        parent.node_ops.rmdir(parent, name);
        FS.destroyNode(node);
        try { if (FS.trackingDelegate["onDeletePath"]) FS.trackingDelegate["onDeletePath"](path) } catch (e) { console.log("FS.trackingDelegate['onDeletePath']('" + path + "') threw an exception: " + e.message) }
    }),
    readdir: (function(path) { var lookup = FS.lookupPath(path, { follow: true }); var node = lookup.node; if (!node.node_ops.readdir) { throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR) } return node.node_ops.readdir(node) }),
    unlink: (function(path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var err = FS.mayDelete(parent, name, false);
        if (err) { throw new FS.ErrnoError(err) }
        if (!parent.node_ops.unlink) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) }
        if (FS.isMountpoint(node)) { throw new FS.ErrnoError(ERRNO_CODES.EBUSY) }
        try { if (FS.trackingDelegate["willDeletePath"]) { FS.trackingDelegate["willDeletePath"](path) } } catch (e) { console.log("FS.trackingDelegate['willDeletePath']('" + path + "') threw an exception: " + e.message) }
        parent.node_ops.unlink(parent, name);
        FS.destroyNode(node);
        try { if (FS.trackingDelegate["onDeletePath"]) FS.trackingDelegate["onDeletePath"](path) } catch (e) { console.log("FS.trackingDelegate['onDeletePath']('" + path + "') threw an exception: " + e.message) }
    }),
    readlink: (function(path) { var lookup = FS.lookupPath(path); var link = lookup.node; if (!link) { throw new FS.ErrnoError(ERRNO_CODES.ENOENT) } if (!link.node_ops.readlink) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) } return PATH.resolve(FS.getPath(link.parent), link.node_ops.readlink(link)) }),
    stat: (function(path, dontFollow) { var lookup = FS.lookupPath(path, { follow: !dontFollow }); var node = lookup.node; if (!node) { throw new FS.ErrnoError(ERRNO_CODES.ENOENT) } if (!node.node_ops.getattr) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) } return node.node_ops.getattr(node) }),
    lstat: (function(path) { return FS.stat(path, true) }),
    chmod: (function(path, mode, dontFollow) {
        var node;
        if (typeof path === "string") {
            var lookup = FS.lookupPath(path, { follow: !dontFollow });
            node = lookup.node
        } else { node = path }
        if (!node.node_ops.setattr) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) }
        node.node_ops.setattr(node, { mode: mode & 4095 | node.mode & ~4095, timestamp: Date.now() })
    }),
    lchmod: (function(path, mode) { FS.chmod(path, mode, true) }),
    fchmod: (function(fd, mode) {
        var stream = FS.getStream(fd);
        if (!stream) { throw new FS.ErrnoError(ERRNO_CODES.EBADF) }
        FS.chmod(stream.node, mode)
    }),
    chown: (function(path, uid, gid, dontFollow) {
        var node;
        if (typeof path === "string") {
            var lookup = FS.lookupPath(path, { follow: !dontFollow });
            node = lookup.node
        } else { node = path }
        if (!node.node_ops.setattr) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) }
        node.node_ops.setattr(node, { timestamp: Date.now() })
    }),
    lchown: (function(path, uid, gid) { FS.chown(path, uid, gid, true) }),
    fchown: (function(fd, uid, gid) {
        var stream = FS.getStream(fd);
        if (!stream) { throw new FS.ErrnoError(ERRNO_CODES.EBADF) }
        FS.chown(stream.node, uid, gid)
    }),
    truncate: (function(path, len) {
        if (len < 0) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) }
        var node;
        if (typeof path === "string") {
            var lookup = FS.lookupPath(path, { follow: true });
            node = lookup.node
        } else { node = path }
        if (!node.node_ops.setattr) { throw new FS.ErrnoError(ERRNO_CODES.EPERM) }
        if (FS.isDir(node.mode)) { throw new FS.ErrnoError(ERRNO_CODES.EISDIR) }
        if (!FS.isFile(node.mode)) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) }
        var err = FS.nodePermissions(node, "w");
        if (err) { throw new FS.ErrnoError(err) }
        node.node_ops.setattr(node, { size: len, timestamp: Date.now() })
    }),
    ftruncate: (function(fd, len) {
        var stream = FS.getStream(fd);
        if (!stream) { throw new FS.ErrnoError(ERRNO_CODES.EBADF) }
        if ((stream.flags & 2097155) === 0) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) }
        FS.truncate(stream.node, len)
    }),
    utime: (function(path, atime, mtime) {
        var lookup = FS.lookupPath(path, { follow: true });
        var node = lookup.node;
        node.node_ops.setattr(node, { timestamp: Math.max(atime, mtime) })
    }),
    open: (function(path, flags, mode, fd_start, fd_end) {
        if (path === "") { throw new FS.ErrnoError(ERRNO_CODES.ENOENT) }
        flags = typeof flags === "string" ? FS.modeStringToFlags(flags) : flags;
        mode = typeof mode === "undefined" ? 438 : mode;
        if (flags & 64) { mode = mode & 4095 | 32768 } else { mode = 0 }
        var node;
        if (typeof path === "object") { node = path } else {
            path = PATH.normalize(path);
            try {
                var lookup = FS.lookupPath(path, { follow: !(flags & 131072) });
                node = lookup.node
            } catch (e) {}
        }
        var created = false;
        if (flags & 64) {
            if (node) { if (flags & 128) { throw new FS.ErrnoError(ERRNO_CODES.EEXIST) } } else {
                node = FS.mknod(path, mode, 0);
                created = true
            }
        }
        if (!node) { throw new FS.ErrnoError(ERRNO_CODES.ENOENT) }
        if (FS.isChrdev(node.mode)) { flags &= ~512 }
        if (flags & 65536 && !FS.isDir(node.mode)) { throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR) }
        if (!created) { var err = FS.mayOpen(node, flags); if (err) { throw new FS.ErrnoError(err) } }
        if (flags & 512) { FS.truncate(node, 0) }
        flags &= ~(128 | 512);
        var stream = FS.createStream({ node: node, path: FS.getPath(node), flags: flags, seekable: true, position: 0, stream_ops: node.stream_ops, ungotten: [], error: false }, fd_start, fd_end);
        if (stream.stream_ops.open) { stream.stream_ops.open(stream) }
        if (Module["logReadFiles"] && !(flags & 1)) {
            if (!FS.readFiles) FS.readFiles = {};
            if (!(path in FS.readFiles)) {
                FS.readFiles[path] = 1;
                console.log("FS.trackingDelegate error on read file: " + path)
            }
        }
        try {
            if (FS.trackingDelegate["onOpenFile"]) {
                var trackingFlags = 0;
                if ((flags & 2097155) !== 1) { trackingFlags |= FS.tracking.openFlags.READ }
                if ((flags & 2097155) !== 0) { trackingFlags |= FS.tracking.openFlags.WRITE }
                FS.trackingDelegate["onOpenFile"](path, trackingFlags)
            }
        } catch (e) { console.log("FS.trackingDelegate['onOpenFile']('" + path + "', flags) threw an exception: " + e.message) }
        return stream
    }),
    close: (function(stream) {
        if (FS.isClosed(stream)) { throw new FS.ErrnoError(ERRNO_CODES.EBADF) }
        if (stream.getdents) stream.getdents = null;
        try { if (stream.stream_ops.close) { stream.stream_ops.close(stream) } } catch (e) { throw e } finally { FS.closeStream(stream.fd) }
        stream.fd = null
    }),
    isClosed: (function(stream) { return stream.fd === null }),
    llseek: (function(stream, offset, whence) {
        if (FS.isClosed(stream)) { throw new FS.ErrnoError(ERRNO_CODES.EBADF) }
        if (!stream.seekable || !stream.stream_ops.llseek) { throw new FS.ErrnoError(ERRNO_CODES.ESPIPE) }
        stream.position = stream.stream_ops.llseek(stream, offset, whence);
        stream.ungotten = [];
        return stream.position
    }),
    read: (function(stream, buffer, offset, length, position) { if (length < 0 || position < 0) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) } if (FS.isClosed(stream)) { throw new FS.ErrnoError(ERRNO_CODES.EBADF) } if ((stream.flags & 2097155) === 1) { throw new FS.ErrnoError(ERRNO_CODES.EBADF) } if (FS.isDir(stream.node.mode)) { throw new FS.ErrnoError(ERRNO_CODES.EISDIR) } if (!stream.stream_ops.read) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) } var seeking = typeof position !== "undefined"; if (!seeking) { position = stream.position } else if (!stream.seekable) { throw new FS.ErrnoError(ERRNO_CODES.ESPIPE) } var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position); if (!seeking) stream.position += bytesRead; return bytesRead }),
    write: (function(stream, buffer, offset, length, position, canOwn) { if (length < 0 || position < 0) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) } if (FS.isClosed(stream)) { throw new FS.ErrnoError(ERRNO_CODES.EBADF) } if ((stream.flags & 2097155) === 0) { throw new FS.ErrnoError(ERRNO_CODES.EBADF) } if (FS.isDir(stream.node.mode)) { throw new FS.ErrnoError(ERRNO_CODES.EISDIR) } if (!stream.stream_ops.write) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) } if (stream.flags & 1024) { FS.llseek(stream, 0, 2) } var seeking = typeof position !== "undefined"; if (!seeking) { position = stream.position } else if (!stream.seekable) { throw new FS.ErrnoError(ERRNO_CODES.ESPIPE) } var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn); if (!seeking) stream.position += bytesWritten; try { if (stream.path && FS.trackingDelegate["onWriteToFile"]) FS.trackingDelegate["onWriteToFile"](stream.path) } catch (e) { console.log("FS.trackingDelegate['onWriteToFile']('" + path + "') threw an exception: " + e.message) } return bytesWritten }),
    allocate: (function(stream, offset, length) {
        if (FS.isClosed(stream)) { throw new FS.ErrnoError(ERRNO_CODES.EBADF) }
        if (offset < 0 || length <= 0) { throw new FS.ErrnoError(ERRNO_CODES.EINVAL) }
        if ((stream.flags & 2097155) === 0) { throw new FS.ErrnoError(ERRNO_CODES.EBADF) }
        if (!FS.isFile(stream.node.mode) && !FS.isDir(stream.node.mode)) { throw new FS.ErrnoError(ERRNO_CODES.ENODEV) }
        if (!stream.stream_ops.allocate) { throw new FS.ErrnoError(ERRNO_CODES.EOPNOTSUPP) }
        stream.stream_ops.allocate(stream, offset, length)
    }),
    mmap: (function(stream, buffer, offset, length, position, prot, flags) { if ((stream.flags & 2097155) === 1) { throw new FS.ErrnoError(ERRNO_CODES.EACCES) } if (!stream.stream_ops.mmap) { throw new FS.ErrnoError(ERRNO_CODES.ENODEV) } return stream.stream_ops.mmap(stream, buffer, offset, length, position, prot, flags) }),
    msync: (function(stream, buffer, offset, length, mmapFlags) { if (!stream || !stream.stream_ops.msync) { return 0 } return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags) }),
    munmap: (function(stream) { return 0 }),
    ioctl: (function(stream, cmd, arg) { if (!stream.stream_ops.ioctl) { throw new FS.ErrnoError(ERRNO_CODES.ENOTTY) } return stream.stream_ops.ioctl(stream, cmd, arg) }),
    readFile: (function(path, opts) {
        opts = opts || {};
        opts.flags = opts.flags || "r";
        opts.encoding = opts.encoding || "binary";
        if (opts.encoding !== "utf8" && opts.encoding !== "binary") { throw new Error('Invalid encoding type "' + opts.encoding + '"') }
        var ret;
        var stream = FS.open(path, opts.flags);
        var stat = FS.stat(path);
        var length = stat.size;
        var buf = new Uint8Array(length);
        FS.read(stream, buf, 0, length, 0);
        if (opts.encoding === "utf8") { ret = UTF8ArrayToString(buf, 0) } else if (opts.encoding === "binary") { ret = buf }
        FS.close(stream);
        return ret
    }),
    writeFile: (function(path, data, opts) {
        opts = opts || {};
        opts.flags = opts.flags || "w";
        var stream = FS.open(path, opts.flags, opts.mode);
        if (typeof data === "string") {
            var buf = new Uint8Array(lengthBytesUTF8(data) + 1);
            var actualNumBytes = stringToUTF8Array(data, buf, 0, buf.length);
            FS.write(stream, buf, 0, actualNumBytes, undefined, opts.canOwn)
        } else if (ArrayBuffer.isView(data)) { FS.write(stream, data, 0, data.byteLength, undefined, opts.canOwn) } else { throw new Error("Unsupported data type") }
        FS.close(stream)
    }),
    cwd: (function() { return FS.currentPath }),
    chdir: (function(path) {
        var lookup = FS.lookupPath(path, { follow: true });
        if (lookup.node === null) { throw new FS.ErrnoError(ERRNO_CODES.ENOENT) }
        if (!FS.isDir(lookup.node.mode)) { throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR) }
        var err = FS.nodePermissions(lookup.node, "x");
        if (err) { throw new FS.ErrnoError(err) }
        FS.currentPath = lookup.path
    }),
    createDefaultDirectories: (function() {
        FS.mkdir("/tmp");
        FS.mkdir("/home");
        FS.mkdir("/home/web_user")
    }),
    createDefaultDevices: (function() {
        FS.mkdir("/dev");
        FS.registerDevice(FS.makedev(1, 3), { read: (function() { return 0 }), write: (function(stream, buffer, offset, length, pos) { return length }) });
        FS.mkdev("/dev/null", FS.makedev(1, 3));
        TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
        TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
        FS.mkdev("/dev/tty", FS.makedev(5, 0));
        FS.mkdev("/dev/tty1", FS.makedev(6, 0));
        var random_device;
        if (typeof crypto !== "undefined") {
            var randomBuffer = new Uint8Array(1);
            random_device = (function() { crypto.getRandomValues(randomBuffer); return randomBuffer[0] })
        } else if (ENVIRONMENT_IS_NODE) { random_device = (function() { return require("crypto")["randomBytes"](1)[0] }) } else { random_device = (function() { abort("random_device") }) }
        FS.createDevice("/dev", "random", random_device);
        FS.createDevice("/dev", "urandom", random_device);
        FS.mkdir("/dev/shm");
        FS.mkdir("/dev/shm/tmp")
    }),
    createSpecialDirectories: (function() {
        FS.mkdir("/proc");
        FS.mkdir("/proc/self");
        FS.mkdir("/proc/self/fd");
        FS.mount({
            mount: (function() {
                var node = FS.createNode("/proc/self", "fd", 16384 | 511, 73);
                node.node_ops = {
                    lookup: (function(parent, name) {
                        var fd = +name;
                        var stream = FS.getStream(fd);
                        if (!stream) throw new FS.ErrnoError(ERRNO_CODES.EBADF);
                        var ret = { parent: null, mount: { mountpoint: "fake" }, node_ops: { readlink: (function() { return stream.path }) } };
                        ret.parent = ret;
                        return ret
                    })
                };
                return node
            })
        }, {}, "/proc/self/fd")
    }),
    createStandardStreams: (function() {
        if (Module["stdin"]) { FS.createDevice("/dev", "stdin", Module["stdin"]) } else { FS.symlink("/dev/tty", "/dev/stdin") }
        if (Module["stdout"]) { FS.createDevice("/dev", "stdout", null, Module["stdout"]) } else { FS.symlink("/dev/tty", "/dev/stdout") }
        if (Module["stderr"]) { FS.createDevice("/dev", "stderr", null, Module["stderr"]) } else { FS.symlink("/dev/tty1", "/dev/stderr") }
        var stdin = FS.open("/dev/stdin", "r");
        assert(stdin.fd === 0, "invalid handle for stdin (" + stdin.fd + ")");
        var stdout = FS.open("/dev/stdout", "w");
        assert(stdout.fd === 1, "invalid handle for stdout (" + stdout.fd + ")");
        var stderr = FS.open("/dev/stderr", "w");
        assert(stderr.fd === 2, "invalid handle for stderr (" + stderr.fd + ")")
    }),
    ensureErrnoError: (function() {
        if (FS.ErrnoError) return;
        FS.ErrnoError = function ErrnoError(errno, node) {
            this.node = node;
            this.setErrno = (function(errno) { this.errno = errno; for (var key in ERRNO_CODES) { if (ERRNO_CODES[key] === errno) { this.code = key; break } } });
            this.setErrno(errno);
            this.message = ERRNO_MESSAGES[errno];
            if (this.stack) Object.defineProperty(this, "stack", { value: (new Error).stack, writable: true })
        };
        FS.ErrnoError.prototype = new Error;
        FS.ErrnoError.prototype.constructor = FS.ErrnoError;
        [ERRNO_CODES.ENOENT].forEach((function(code) {
            FS.genericErrors[code] = new FS.ErrnoError(code);
            FS.genericErrors[code].stack = "<generic error, no stack>"
        }))
    }),
    staticInit: (function() {
        FS.ensureErrnoError();
        FS.nameTable = new Array(4096);
        FS.mount(MEMFS, {}, "/");
        FS.createDefaultDirectories();
        FS.createDefaultDevices();
        FS.createSpecialDirectories();
        FS.filesystems = { "MEMFS": MEMFS, "IDBFS": IDBFS, "NODEFS": NODEFS, "WORKERFS": WORKERFS }
    }),
    init: (function(input, output, error) {
        assert(!FS.init.initialized, "FS.init was previously called. If you want to initialize later with custom parameters, remove any earlier calls (note that one is automatically added to the generated code)");
        FS.init.initialized = true;
        FS.ensureErrnoError();
        Module["stdin"] = input || Module["stdin"];
        Module["stdout"] = output || Module["stdout"];
        Module["stderr"] = error || Module["stderr"];
        FS.createStandardStreams()
    }),
    quit: (function() {
        FS.init.initialized = false;
        var fflush = Module["_fflush"];
        if (fflush) fflush(0);
        for (var i = 0; i < FS.streams.length; i++) {
            var stream = FS.streams[i];
            if (!stream) { continue }
            FS.close(stream)
        }
    }),
    getMode: (function(canRead, canWrite) { var mode = 0; if (canRead) mode |= 292 | 73; if (canWrite) mode |= 146; return mode }),
    joinPath: (function(parts, forceRelative) { var path = PATH.join.apply(null, parts); if (forceRelative && path[0] == "/") path = path.substr(1); return path }),
    absolutePath: (function(relative, base) { return PATH.resolve(base, relative) }),
    standardizePath: (function(path) { return PATH.normalize(path) }),
    findObject: (function(path, dontResolveLastLink) { var ret = FS.analyzePath(path, dontResolveLastLink); if (ret.exists) { return ret.object } else { ___setErrNo(ret.error); return null } }),
    analyzePath: (function(path, dontResolveLastLink) {
        try {
            var lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
            path = lookup.path
        } catch (e) {}
        var ret = { isRoot: false, exists: false, error: 0, name: null, path: null, object: null, parentExists: false, parentPath: null, parentObject: null };
        try {
            var lookup = FS.lookupPath(path, { parent: true });
            ret.parentExists = true;
            ret.parentPath = lookup.path;
            ret.parentObject = lookup.node;
            ret.name = PATH.basename(path);
            lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
            ret.exists = true;
            ret.path = lookup.path;
            ret.object = lookup.node;
            ret.name = lookup.node.name;
            ret.isRoot = lookup.path === "/"
        } catch (e) { ret.error = e.errno }
        return ret
    }),
    createFolder: (function(parent, name, canRead, canWrite) { var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name); var mode = FS.getMode(canRead, canWrite); return FS.mkdir(path, mode) }),
    createPath: (function(parent, path, canRead, canWrite) {
        parent = typeof parent === "string" ? parent : FS.getPath(parent);
        var parts = path.split("/").reverse();
        while (parts.length) {
            var part = parts.pop();
            if (!part) continue;
            var current = PATH.join2(parent, part);
            try { FS.mkdir(current) } catch (e) {}
            parent = current
        }
        return current
    }),
    createFile: (function(parent, name, properties, canRead, canWrite) { var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name); var mode = FS.getMode(canRead, canWrite); return FS.create(path, mode) }),
    createDataFile: (function(parent, name, data, canRead, canWrite, canOwn) {
        var path = name ? PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name) : parent;
        var mode = FS.getMode(canRead, canWrite);
        var node = FS.create(path, mode);
        if (data) {
            if (typeof data === "string") {
                var arr = new Array(data.length);
                for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
                data = arr
            }
            FS.chmod(node, mode | 146);
            var stream = FS.open(node, "w");
            FS.write(stream, data, 0, data.length, 0, canOwn);
            FS.close(stream);
            FS.chmod(node, mode)
        }
        return node
    }),
    createDevice: (function(parent, name, input, output) {
        var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name);
        var mode = FS.getMode(!!input, !!output);
        if (!FS.createDevice.major) FS.createDevice.major = 64;
        var dev = FS.makedev(FS.createDevice.major++, 0);
        FS.registerDevice(dev, {
            open: (function(stream) { stream.seekable = false }),
            close: (function(stream) { if (output && output.buffer && output.buffer.length) { output(10) } }),
            read: (function(stream, buffer, offset, length, pos) {
                var bytesRead = 0;
                for (var i = 0; i < length; i++) {
                    var result;
                    try { result = input() } catch (e) { throw new FS.ErrnoError(ERRNO_CODES.EIO) }
                    if (result === undefined && bytesRead === 0) { throw new FS.ErrnoError(ERRNO_CODES.EAGAIN) }
                    if (result === null || result === undefined) break;
                    bytesRead++;
                    buffer[offset + i] = result
                }
                if (bytesRead) { stream.node.timestamp = Date.now() }
                return bytesRead
            }),
            write: (function(stream, buffer, offset, length, pos) { for (var i = 0; i < length; i++) { try { output(buffer[offset + i]) } catch (e) { throw new FS.ErrnoError(ERRNO_CODES.EIO) } } if (length) { stream.node.timestamp = Date.now() } return i })
        });
        return FS.mkdev(path, mode, dev)
    }),
    createLink: (function(parent, name, target, canRead, canWrite) { var path = PATH.join2(typeof parent === "string" ? parent : FS.getPath(parent), name); return FS.symlink(target, path) }),
    forceLoadFile: (function(obj) {
        if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
        var success = true;
        if (typeof XMLHttpRequest !== "undefined") { throw new Error("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.") } else if (Module["read"]) {
            try {
                obj.contents = intArrayFromString(Module["read"](obj.url), true);
                obj.usedBytes = obj.contents.length
            } catch (e) { success = false }
        } else { throw new Error("Cannot load without read() or XMLHttpRequest.") }
        if (!success) ___setErrNo(ERRNO_CODES.EIO);
        return success
    }),
    createLazyFile: (function(parent, name, url, canRead, canWrite) {
        function LazyUint8Array() {
            this.lengthKnown = false;
            this.chunks = []
        }
        LazyUint8Array.prototype.get = function LazyUint8Array_get(idx) { if (idx > this.length - 1 || idx < 0) { return undefined } var chunkOffset = idx % this.chunkSize; var chunkNum = idx / this.chunkSize | 0; return this.getter(chunkNum)[chunkOffset] };
        LazyUint8Array.prototype.setDataGetter = function LazyUint8Array_setDataGetter(getter) { this.getter = getter };
        LazyUint8Array.prototype.cacheLength = function LazyUint8Array_cacheLength() {
            var xhr = new XMLHttpRequest;
            xhr.open("HEAD", url, false);
            xhr.send(null);
            if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
            var datalength = Number(xhr.getResponseHeader("Content-length"));
            var header;
            var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
            var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
            var chunkSize = 1024 * 1024;
            if (!hasByteServing) chunkSize = datalength;
            var doXHR = (function(from, to) {
                if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
                if (to > datalength - 1) throw new Error("only " + datalength + " bytes available! programmer error!");
                var xhr = new XMLHttpRequest;
                xhr.open("GET", url, false);
                if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);
                if (typeof Uint8Array != "undefined") xhr.responseType = "arraybuffer";
                if (xhr.overrideMimeType) { xhr.overrideMimeType("text/plain; charset=x-user-defined") }
                xhr.send(null);
                if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
                if (xhr.response !== undefined) { return new Uint8Array(xhr.response || []) } else { return intArrayFromString(xhr.responseText || "", true) }
            });
            var lazyArray = this;
            lazyArray.setDataGetter((function(chunkNum) {
                var start = chunkNum * chunkSize;
                var end = (chunkNum + 1) * chunkSize - 1;
                end = Math.min(end, datalength - 1);
                if (typeof lazyArray.chunks[chunkNum] === "undefined") { lazyArray.chunks[chunkNum] = doXHR(start, end) }
                if (typeof lazyArray.chunks[chunkNum] === "undefined") throw new Error("doXHR failed!");
                return lazyArray.chunks[chunkNum]
            }));
            if (usesGzip || !datalength) {
                chunkSize = datalength = 1;
                datalength = this.getter(0).length;
                chunkSize = datalength;
                console.log("LazyFiles on gzip forces download of the whole file when length is accessed")
            }
            this._length = datalength;
            this._chunkSize = chunkSize;
            this.lengthKnown = true
        };
        if (typeof XMLHttpRequest !== "undefined") {
            if (!ENVIRONMENT_IS_WORKER) throw "Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc";
            var lazyArray = new LazyUint8Array;
            Object.defineProperties(lazyArray, { length: { get: (function() { if (!this.lengthKnown) { this.cacheLength() } return this._length }) }, chunkSize: { get: (function() { if (!this.lengthKnown) { this.cacheLength() } return this._chunkSize }) } });
            var properties = { isDevice: false, contents: lazyArray }
        } else { var properties = { isDevice: false, url: url } }
        var node = FS.createFile(parent, name, properties, canRead, canWrite);
        if (properties.contents) { node.contents = properties.contents } else if (properties.url) {
            node.contents = null;
            node.url = properties.url
        }
        Object.defineProperties(node, { usedBytes: { get: (function() { return this.contents.length }) } });
        var stream_ops = {};
        var keys = Object.keys(node.stream_ops);
        keys.forEach((function(key) {
            var fn = node.stream_ops[key];
            stream_ops[key] = function forceLoadLazyFile() { if (!FS.forceLoadFile(node)) { throw new FS.ErrnoError(ERRNO_CODES.EIO) } return fn.apply(null, arguments) }
        }));
        stream_ops.read = function stream_ops_read(stream, buffer, offset, length, position) {
            if (!FS.forceLoadFile(node)) { throw new FS.ErrnoError(ERRNO_CODES.EIO) }
            var contents = stream.node.contents;
            if (position >= contents.length) return 0;
            var size = Math.min(contents.length - position, length);
            assert(size >= 0);
            if (contents.slice) { for (var i = 0; i < size; i++) { buffer[offset + i] = contents[position + i] } } else { for (var i = 0; i < size; i++) { buffer[offset + i] = contents.get(position + i) } }
            return size
        };
        node.stream_ops = stream_ops;
        return node
    }),
    createPreloadedFile: (function(parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) {
        Browser.init();
        var fullname = name ? PATH.resolve(PATH.join2(parent, name)) : parent;
        var dep = getUniqueRunDependency("cp " + fullname);

        function processData(byteArray) {
            function finish(byteArray) {
                if (preFinish) preFinish();
                if (!dontCreateFile) { FS.createDataFile(parent, name, byteArray, canRead, canWrite, canOwn) }
                if (onload) onload();
                removeRunDependency(dep)
            }
            var handled = false;
            Module["preloadPlugins"].forEach((function(plugin) {
                if (handled) return;
                if (plugin["canHandle"](fullname)) {
                    plugin["handle"](byteArray, fullname, finish, (function() {
                        if (onerror) onerror();
                        removeRunDependency(dep)
                    }));
                    handled = true
                }
            }));
            if (!handled) finish(byteArray)
        }
        addRunDependency(dep);
        if (typeof url == "string") { Browser.asyncLoad(url, (function(byteArray) { processData(byteArray) }), onerror) } else { processData(url) }
    }),
    indexedDB: (function() { return window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB }),
    DB_NAME: (function() { return "EM_FS_" + window.location.pathname }),
    DB_VERSION: 20,
    DB_STORE_NAME: "FILE_DATA",
    saveFilesToDB: (function(paths, onload, onerror) {
        onload = onload || (function() {});
        onerror = onerror || (function() {});
        var indexedDB = FS.indexedDB();
        try { var openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION) } catch (e) { return onerror(e) }
        openRequest.onupgradeneeded = function openRequest_onupgradeneeded() {
            console.log("creating db");
            var db = openRequest.result;
            db.createObjectStore(FS.DB_STORE_NAME)
        };
        openRequest.onsuccess = function openRequest_onsuccess() {
            var db = openRequest.result;
            var transaction = db.transaction([FS.DB_STORE_NAME], "readwrite");
            var files = transaction.objectStore(FS.DB_STORE_NAME);
            var ok = 0,
                fail = 0,
                total = paths.length;

            function finish() {
                if (fail == 0) onload();
                else onerror()
            }
            paths.forEach((function(path) {
                var putRequest = files.put(FS.analyzePath(path).object.contents, path);
                putRequest.onsuccess = function putRequest_onsuccess() { ok++; if (ok + fail == total) finish() };
                putRequest.onerror = function putRequest_onerror() { fail++; if (ok + fail == total) finish() }
            }));
            transaction.onerror = onerror
        };
        openRequest.onerror = onerror
    }),
    loadFilesFromDB: (function(paths, onload, onerror) {
        onload = onload || (function() {});
        onerror = onerror || (function() {});
        var indexedDB = FS.indexedDB();
        try { var openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION) } catch (e) { return onerror(e) }
        openRequest.onupgradeneeded = onerror;
        openRequest.onsuccess = function openRequest_onsuccess() {
            var db = openRequest.result;
            try { var transaction = db.transaction([FS.DB_STORE_NAME], "readonly") } catch (e) { onerror(e); return }
            var files = transaction.objectStore(FS.DB_STORE_NAME);
            var ok = 0,
                fail = 0,
                total = paths.length;

            function finish() {
                if (fail == 0) onload();
                else onerror()
            }
            paths.forEach((function(path) {
                var getRequest = files.get(path);
                getRequest.onsuccess = function getRequest_onsuccess() {
                    if (FS.analyzePath(path).exists) { FS.unlink(path) }
                    FS.createDataFile(PATH.dirname(path), PATH.basename(path), getRequest.result, true, true, true);
                    ok++;
                    if (ok + fail == total) finish()
                };
                getRequest.onerror = function getRequest_onerror() { fail++; if (ok + fail == total) finish() }
            }));
            transaction.onerror = onerror
        };
        openRequest.onerror = onerror
    })
};
var SYSCALLS = {
    DEFAULT_POLLMASK: 5,
    mappings: {},
    umask: 511,
    calculateAt: (function(dirfd, path) {
        if (path[0] !== "/") {
            var dir;
            if (dirfd === -100) { dir = FS.cwd() } else {
                var dirstream = FS.getStream(dirfd);
                if (!dirstream) throw new FS.ErrnoError(ERRNO_CODES.EBADF);
                dir = dirstream.path
            }
            path = PATH.join2(dir, path)
        }
        return path
    }),
    doStat: (function(func, path, buf) {
        try { var stat = func(path) } catch (e) { if (e && e.node && PATH.normalize(path) !== PATH.normalize(FS.getPath(e.node))) { return -ERRNO_CODES.ENOTDIR } throw e }
        HEAP32[buf >> 2] = stat.dev;
        HEAP32[buf + 4 >> 2] = 0;
        HEAP32[buf + 8 >> 2] = stat.ino;
        HEAP32[buf + 12 >> 2] = stat.mode;
        HEAP32[buf + 16 >> 2] = stat.nlink;
        HEAP32[buf + 20 >> 2] = stat.uid;
        HEAP32[buf + 24 >> 2] = stat.gid;
        HEAP32[buf + 28 >> 2] = stat.rdev;
        HEAP32[buf + 32 >> 2] = 0;
        HEAP32[buf + 36 >> 2] = stat.size;
        HEAP32[buf + 40 >> 2] = 4096;
        HEAP32[buf + 44 >> 2] = stat.blocks;
        HEAP32[buf + 48 >> 2] = stat.atime.getTime() / 1e3 | 0;
        HEAP32[buf + 52 >> 2] = 0;
        HEAP32[buf + 56 >> 2] = stat.mtime.getTime() / 1e3 | 0;
        HEAP32[buf + 60 >> 2] = 0;
        HEAP32[buf + 64 >> 2] = stat.ctime.getTime() / 1e3 | 0;
        HEAP32[buf + 68 >> 2] = 0;
        HEAP32[buf + 72 >> 2] = stat.ino;
        return 0
    }),
    doMsync: (function(addr, stream, len, flags) {
        var buffer = new Uint8Array(HEAPU8.subarray(addr, addr + len));
        FS.msync(stream, buffer, 0, len, flags)
    }),
    doMkdir: (function(path, mode) {
        path = PATH.normalize(path);
        if (path[path.length - 1] === "/") path = path.substr(0, path.length - 1);
        FS.mkdir(path, mode, 0);
        return 0
    }),
    doMknod: (function(path, mode, dev) {
        switch (mode & 61440) {
            case 32768:
            case 8192:
            case 24576:
            case 4096:
            case 49152:
                break;
            default:
                return -ERRNO_CODES.EINVAL
        }
        FS.mknod(path, mode, dev);
        return 0
    }),
    doReadlink: (function(path, buf, bufsize) {
        if (bufsize <= 0) return -ERRNO_CODES.EINVAL;
        var ret = FS.readlink(path);
        var len = Math.min(bufsize, lengthBytesUTF8(ret));
        var endChar = HEAP8[buf + len];
        stringToUTF8(ret, buf, bufsize + 1);
        HEAP8[buf + len] = endChar;
        return len
    }),
    doAccess: (function(path, amode) {
        if (amode & ~7) { return -ERRNO_CODES.EINVAL }
        var node;
        var lookup = FS.lookupPath(path, { follow: true });
        node = lookup.node;
        var perms = "";
        if (amode & 4) perms += "r";
        if (amode & 2) perms += "w";
        if (amode & 1) perms += "x";
        if (perms && FS.nodePermissions(node, perms)) { return -ERRNO_CODES.EACCES }
        return 0
    }),
    doDup: (function(path, flags, suggestFD) { var suggest = FS.getStream(suggestFD); if (suggest) FS.close(suggest); return FS.open(path, flags, 0, suggestFD, suggestFD).fd }),
    doReadv: (function(stream, iov, iovcnt, offset) {
        var ret = 0;
        for (var i = 0; i < iovcnt; i++) {
            var ptr = HEAP32[iov + i * 8 >> 2];
            var len = HEAP32[iov + (i * 8 + 4) >> 2];
            var curr = FS.read(stream, HEAP8, ptr, len, offset);
            if (curr < 0) return -1;
            ret += curr;
            if (curr < len) break
        }
        return ret
    }),
    doWritev: (function(stream, iov, iovcnt, offset) {
        var ret = 0;
        for (var i = 0; i < iovcnt; i++) {
            var ptr = HEAP32[iov + i * 8 >> 2];
            var len = HEAP32[iov + (i * 8 + 4) >> 2];
            var curr = FS.write(stream, HEAP8, ptr, len, offset);
            if (curr < 0) return -1;
            ret += curr
        }
        return ret
    }),
    varargs: 0,
    get: (function(varargs) { SYSCALLS.varargs += 4; var ret = HEAP32[SYSCALLS.varargs - 4 >> 2]; return ret }),
    getStr: (function() { var ret = Pointer_stringify(SYSCALLS.get()); return ret }),
    getStreamFromFD: (function() { var stream = FS.getStream(SYSCALLS.get()); if (!stream) throw new FS.ErrnoError(ERRNO_CODES.EBADF); return stream }),
    getSocketFromFD: (function() { var socket = SOCKFS.getSocket(SYSCALLS.get()); if (!socket) throw new FS.ErrnoError(ERRNO_CODES.EBADF); return socket }),
    getSocketAddress: (function(allowNull) {
        var addrp = SYSCALLS.get(),
            addrlen = SYSCALLS.get();
        if (allowNull && addrp === 0) return null;
        var info = __read_sockaddr(addrp, addrlen);
        if (info.errno) throw new FS.ErrnoError(info.errno);
        info.addr = DNS.lookup_addr(info.addr) || info.addr;
        return info
    }),
    get64: (function() {
        var low = SYSCALLS.get(),
            high = SYSCALLS.get();
        if (low >= 0) assert(high === 0);
        else assert(high === -1);
        return low
    }),
    getZero: (function() { assert(SYSCALLS.get() === 0) })
};

function ___syscall140(which, varargs) {
    SYSCALLS.varargs = varargs;
    try {
        var stream = SYSCALLS.getStreamFromFD(),
            offset_high = SYSCALLS.get(),
            offset_low = SYSCALLS.get(),
            result = SYSCALLS.get(),
            whence = SYSCALLS.get();
        var offset = offset_low;
        FS.llseek(stream, offset, whence);
        HEAP32[result >> 2] = stream.position;
        if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null;
        return 0
    } catch (e) { if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e); return -e.errno }
}

function ___syscall145(which, varargs) {
    SYSCALLS.varargs = varargs;
    try {
        var stream = SYSCALLS.getStreamFromFD(),
            iov = SYSCALLS.get(),
            iovcnt = SYSCALLS.get();
        return SYSCALLS.doReadv(stream, iov, iovcnt)
    } catch (e) { if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e); return -e.errno }
}

function ___syscall146(which, varargs) {
    SYSCALLS.varargs = varargs;
    try {
        var stream = SYSCALLS.getStreamFromFD(),
            iov = SYSCALLS.get(),
            iovcnt = SYSCALLS.get();
        return SYSCALLS.doWritev(stream, iov, iovcnt)
    } catch (e) { if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e); return -e.errno }
}

function ___syscall221(which, varargs) {
    SYSCALLS.varargs = varargs;
    try {
        var stream = SYSCALLS.getStreamFromFD(),
            cmd = SYSCALLS.get();
        switch (cmd) {
            case 0:
                { var arg = SYSCALLS.get(); if (arg < 0) { return -ERRNO_CODES.EINVAL } var newStream;newStream = FS.open(stream.path, stream.flags, 0, arg); return newStream.fd };
            case 1:
            case 2:
                return 0;
            case 3:
                return stream.flags;
            case 4:
                { var arg = SYSCALLS.get();stream.flags |= arg; return 0 };
            case 12:
            case 12:
                { var arg = SYSCALLS.get(); var offset = 0;HEAP16[arg + offset >> 1] = 2; return 0 };
            case 13:
            case 14:
            case 13:
            case 14:
                return 0;
            case 16:
            case 8:
                return -ERRNO_CODES.EINVAL;
            case 9:
                ___setErrNo(ERRNO_CODES.EINVAL);
                return -1;
            default:
                { return -ERRNO_CODES.EINVAL }
        }
    } catch (e) { if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e); return -e.errno }
}

function ___syscall5(which, varargs) {
    SYSCALLS.varargs = varargs;
    try {
        var pathname = SYSCALLS.getStr(),
            flags = SYSCALLS.get(),
            mode = SYSCALLS.get();
        var stream = FS.open(pathname, flags, mode);
        return stream.fd
    } catch (e) { if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e); return -e.errno }
}

function ___syscall54(which, varargs) {
    SYSCALLS.varargs = varargs;
    try {
        var stream = SYSCALLS.getStreamFromFD(),
            op = SYSCALLS.get();
        switch (op) {
            case 21509:
            case 21505:
                { if (!stream.tty) return -ERRNO_CODES.ENOTTY; return 0 };
            case 21510:
            case 21511:
            case 21512:
            case 21506:
            case 21507:
            case 21508:
                { if (!stream.tty) return -ERRNO_CODES.ENOTTY; return 0 };
            case 21519:
                { if (!stream.tty) return -ERRNO_CODES.ENOTTY; var argp = SYSCALLS.get();HEAP32[argp >> 2] = 0; return 0 };
            case 21520:
                { if (!stream.tty) return -ERRNO_CODES.ENOTTY; return -ERRNO_CODES.EINVAL };
            case 21531:
                { var argp = SYSCALLS.get(); return FS.ioctl(stream, op, argp) };
            case 21523:
                { if (!stream.tty) return -ERRNO_CODES.ENOTTY; return 0 };
            case 21524:
                { if (!stream.tty) return -ERRNO_CODES.ENOTTY; return 0 };
            default:
                abort("bad ioctl syscall " + op)
        }
    } catch (e) { if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e); return -e.errno }
}

function ___syscall6(which, varargs) {
    SYSCALLS.varargs = varargs;
    try {
        var stream = SYSCALLS.getStreamFromFD();
        FS.close(stream);
        return 0
    } catch (e) { if (typeof FS === "undefined" || !(e instanceof FS.ErrnoError)) abort(e); return -e.errno }
}

function ___unlock() {}

function _emscripten_get_now() { abort() }

function _emscripten_get_now_is_monotonic() { return ENVIRONMENT_IS_NODE || typeof dateNow !== "undefined" || (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) && self["performance"] && self["performance"]["now"] }

function _clock_gettime(clk_id, tp) {
    var now;
    if (clk_id === 0) { now = Date.now() } else if (clk_id === 1 && _emscripten_get_now_is_monotonic()) { now = _emscripten_get_now() } else { ___setErrNo(ERRNO_CODES.EINVAL); return -1 }
    HEAP32[tp >> 2] = now / 1e3 | 0;
    HEAP32[tp + 4 >> 2] = now % 1e3 * 1e3 * 1e3 | 0;
    return 0
}
var DLFCN = { error: null, errorMsg: null, loadedLibs: {}, loadedLibNames: {} };

function _dlclose(handle) {
    if (!DLFCN.loadedLibs[handle]) { DLFCN.errorMsg = "Tried to dlclose() unopened handle: " + handle; return 1 } else {
        var lib_record = DLFCN.loadedLibs[handle];
        if (--lib_record.refcount == 0) {
            if (lib_record.module.cleanups) { lib_record.module.cleanups.forEach((function(cleanup) { cleanup() })) }
            delete DLFCN.loadedLibNames[lib_record.name];
            delete DLFCN.loadedLibs[handle]
        }
        return 0
    }
}

function _dlerror() {
    if (DLFCN.errorMsg === null) { return 0 } else {
        if (DLFCN.error) _free(DLFCN.error);
        var msgArr = intArrayFromString(DLFCN.errorMsg);
        DLFCN.error = allocate(msgArr, "i8", ALLOC_NORMAL);
        DLFCN.errorMsg = null;
        return DLFCN.error
    }
}

function _dlsym(handle, symbol) {
    symbol = Pointer_stringify(symbol);
    if (!DLFCN.loadedLibs[handle]) { DLFCN.errorMsg = "Tried to dlsym() from an unopened handle: " + handle; return 0 } else {
        var lib = DLFCN.loadedLibs[handle];
        symbol = "_" + symbol;
        if (!lib.module.hasOwnProperty(symbol)) { DLFCN.errorMsg = 'Tried to lookup unknown symbol "' + symbol + '" in dynamic lib: ' + lib.name; return 0 } else { var result = lib.module[symbol]; if (typeof result === "function") { return addFunction(result) } return result }
    }
}

function _emscripten_set_main_loop_timing(mode, value) {
    Browser.mainLoop.timingMode = mode;
    Browser.mainLoop.timingValue = value;
    if (!Browser.mainLoop.func) { return 1 }
    if (mode == 0) {
        Browser.mainLoop.scheduler = function Browser_mainLoop_scheduler_setTimeout() {
            var timeUntilNextTick = Math.max(0, Browser.mainLoop.tickStartTime + value - _emscripten_get_now()) | 0;
            setTimeout(Browser.mainLoop.runner, timeUntilNextTick)
        };
        Browser.mainLoop.method = "timeout"
    } else if (mode == 1) {
        Browser.mainLoop.scheduler = function Browser_mainLoop_scheduler_rAF() { Browser.requestAnimationFrame(Browser.mainLoop.runner) };
        Browser.mainLoop.method = "rAF"
    } else if (mode == 2) {
        if (typeof setImmediate === "undefined") {
            var setImmediates = [];
            var emscriptenMainLoopMessageId = "setimmediate";

            function Browser_setImmediate_messageHandler(event) {
                if (event.data === emscriptenMainLoopMessageId || event.data.target === emscriptenMainLoopMessageId) {
                    event.stopPropagation();
                    setImmediates.shift()()
                }
            }
            addEventListener("message", Browser_setImmediate_messageHandler, true);
            setImmediate = function Browser_emulated_setImmediate(func) {
                setImmediates.push(func);
                if (ENVIRONMENT_IS_WORKER) {
                    if (Module["setImmediates"] === undefined) Module["setImmediates"] = [];
                    Module["setImmediates"].push(func);
                    postMessage({ target: emscriptenMainLoopMessageId })
                } else postMessage(emscriptenMainLoopMessageId, "*")
            }
        }
        Browser.mainLoop.scheduler = function Browser_mainLoop_scheduler_setImmediate() { setImmediate(Browser.mainLoop.runner) };
        Browser.mainLoop.method = "immediate"
    }
    return 0
}

function _emscripten_set_main_loop(func, fps, simulateInfiniteLoop, arg, noSetTiming) {
    Module["noExitRuntime"] = true;
    assert(!Browser.mainLoop.func, "emscripten_set_main_loop: there can only be one main loop function at once: call emscripten_cancel_main_loop to cancel the previous one before setting a new one with different parameters.");
    Browser.mainLoop.func = func;
    Browser.mainLoop.arg = arg;
    var browserIterationFunc;
    if (typeof arg !== "undefined") { browserIterationFunc = (function() { Module["dynCall_vi"](func, arg) }) } else { browserIterationFunc = (function() { Module["dynCall_v"](func) }) }
    var thisMainLoopId = Browser.mainLoop.currentlyRunningMainloop;
    Browser.mainLoop.runner = function Browser_mainLoop_runner() {
        if (ABORT) return;
        if (Browser.mainLoop.queue.length > 0) {
            var start = Date.now();
            var blocker = Browser.mainLoop.queue.shift();
            blocker.func(blocker.arg);
            if (Browser.mainLoop.remainingBlockers) {
                var remaining = Browser.mainLoop.remainingBlockers;
                var next = remaining % 1 == 0 ? remaining - 1 : Math.floor(remaining);
                if (blocker.counted) { Browser.mainLoop.remainingBlockers = next } else {
                    next = next + .5;
                    Browser.mainLoop.remainingBlockers = (8 * remaining + next) / 9
                }
            }
            console.log('main loop blocker "' + blocker.name + '" took ' + (Date.now() - start) + " ms");
            Browser.mainLoop.updateStatus();
            if (thisMainLoopId < Browser.mainLoop.currentlyRunningMainloop) return;
            setTimeout(Browser.mainLoop.runner, 0);
            return
        }
        if (thisMainLoopId < Browser.mainLoop.currentlyRunningMainloop) return;
        Browser.mainLoop.currentFrameNumber = Browser.mainLoop.currentFrameNumber + 1 | 0;
        if (Browser.mainLoop.timingMode == 1 && Browser.mainLoop.timingValue > 1 && Browser.mainLoop.currentFrameNumber % Browser.mainLoop.timingValue != 0) { Browser.mainLoop.scheduler(); return } else if (Browser.mainLoop.timingMode == 0) { Browser.mainLoop.tickStartTime = _emscripten_get_now() }
        if (Browser.mainLoop.method === "timeout" && Module.ctx) {
            err("Looks like you are rendering without using requestAnimationFrame for the main loop. You should use 0 for the frame rate in emscripten_set_main_loop in order to use requestAnimationFrame, as that can greatly improve your frame rates!");
            Browser.mainLoop.method = ""
        }
        Browser.mainLoop.runIter(browserIterationFunc);
        if (thisMainLoopId < Browser.mainLoop.currentlyRunningMainloop) return;
        if (typeof SDL === "object" && SDL.audio && SDL.audio.queueNewAudioData) SDL.audio.queueNewAudioData();
        Browser.mainLoop.scheduler()
    };
    if (!noSetTiming) {
        if (fps && fps > 0) _emscripten_set_main_loop_timing(0, 1e3 / fps);
        else _emscripten_set_main_loop_timing(1, 1);
        Browser.mainLoop.scheduler()
    }
    if (simulateInfiniteLoop) { throw "SimulateInfiniteLoop" }
}
var Browser = {
    mainLoop: {
        scheduler: null,
        method: "",
        currentlyRunningMainloop: 0,
        func: null,
        arg: 0,
        timingMode: 0,
        timingValue: 0,
        currentFrameNumber: 0,
        queue: [],
        pause: (function() {
            Browser.mainLoop.scheduler = null;
            Browser.mainLoop.currentlyRunningMainloop++
        }),
        resume: (function() {
            Browser.mainLoop.currentlyRunningMainloop++;
            var timingMode = Browser.mainLoop.timingMode;
            var timingValue = Browser.mainLoop.timingValue;
            var func = Browser.mainLoop.func;
            Browser.mainLoop.func = null;
            _emscripten_set_main_loop(func, 0, false, Browser.mainLoop.arg, true);
            _emscripten_set_main_loop_timing(timingMode, timingValue);
            Browser.mainLoop.scheduler()
        }),
        updateStatus: (function() { if (Module["setStatus"]) { var message = Module["statusMessage"] || "Please wait..."; var remaining = Browser.mainLoop.remainingBlockers; var expected = Browser.mainLoop.expectedBlockers; if (remaining) { if (remaining < expected) { Module["setStatus"](message + " (" + (expected - remaining) + "/" + expected + ")") } else { Module["setStatus"](message) } } else { Module["setStatus"]("") } } }),
        runIter: (function(func) { if (ABORT) return; if (Module["preMainLoop"]) { var preRet = Module["preMainLoop"](); if (preRet === false) { return } } try { func() } catch (e) { if (e instanceof ExitStatus) { return } else { if (e && typeof e === "object" && e.stack) err("exception thrown: " + [e, e.stack]); throw e } } if (Module["postMainLoop"]) Module["postMainLoop"]() })
    },
    isFullscreen: false,
    pointerLock: false,
    moduleContextCreatedCallbacks: [],
    workers: [],
    init: (function() {
        if (!Module["preloadPlugins"]) Module["preloadPlugins"] = [];
        if (Browser.initted) return;
        Browser.initted = true;
        try {
            new Blob;
            Browser.hasBlobConstructor = true
        } catch (e) {
            Browser.hasBlobConstructor = false;
            console.log("warning: no blob constructor, cannot create blobs with mimetypes")
        }
        Browser.BlobBuilder = typeof MozBlobBuilder != "undefined" ? MozBlobBuilder : typeof WebKitBlobBuilder != "undefined" ? WebKitBlobBuilder : !Browser.hasBlobConstructor ? console.log("warning: no BlobBuilder") : null;
        Browser.URLObject = typeof window != "undefined" ? window.URL ? window.URL : window.webkitURL : undefined;
        if (!Module.noImageDecoding && typeof Browser.URLObject === "undefined") {
            console.log("warning: Browser does not support creating object URLs. Built-in browser image decoding will not be available.");
            Module.noImageDecoding = true
        }
        var imagePlugin = {};
        imagePlugin["canHandle"] = function imagePlugin_canHandle(name) { return !Module.noImageDecoding && /\.(jpg|jpeg|png|bmp)$/i.test(name) };
        imagePlugin["handle"] = function imagePlugin_handle(byteArray, name, onload, onerror) {
            var b = null;
            if (Browser.hasBlobConstructor) { try { b = new Blob([byteArray], { type: Browser.getMimetype(name) }); if (b.size !== byteArray.length) { b = new Blob([(new Uint8Array(byteArray)).buffer], { type: Browser.getMimetype(name) }) } } catch (e) { warnOnce("Blob constructor present but fails: " + e + "; falling back to blob builder") } }
            if (!b) {
                var bb = new Browser.BlobBuilder;
                bb.append((new Uint8Array(byteArray)).buffer);
                b = bb.getBlob()
            }
            var url = Browser.URLObject.createObjectURL(b);
            var img = new Image;
            img.onload = function img_onload() {
                assert(img.complete, "Image " + name + " could not be decoded");
                var canvas = document.createElement("canvas");
                canvas.width = img.width;
                canvas.height = img.height;
                var ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0);
                Module["preloadedImages"][name] = canvas;
                Browser.URLObject.revokeObjectURL(url);
                if (onload) onload(byteArray)
            };
            img.onerror = function img_onerror(event) { console.log("Image " + url + " could not be decoded"); if (onerror) onerror() };
            img.src = url
        };
        Module["preloadPlugins"].push(imagePlugin);
        var audioPlugin = {};
        audioPlugin["canHandle"] = function audioPlugin_canHandle(name) { return !Module.noAudioDecoding && name.substr(-4) in { ".ogg": 1, ".wav": 1, ".mp3": 1 } };
        audioPlugin["handle"] = function audioPlugin_handle(byteArray, name, onload, onerror) {
            var done = false;

            function finish(audio) {
                if (done) return;
                done = true;
                Module["preloadedAudios"][name] = audio;
                if (onload) onload(byteArray)
            }

            function fail() {
                if (done) return;
                done = true;
                Module["preloadedAudios"][name] = new Audio;
                if (onerror) onerror()
            }
            if (Browser.hasBlobConstructor) {
                try { var b = new Blob([byteArray], { type: Browser.getMimetype(name) }) } catch (e) { return fail() }
                var url = Browser.URLObject.createObjectURL(b);
                var audio = new Audio;
                audio.addEventListener("canplaythrough", (function() { finish(audio) }), false);
                audio.onerror = function audio_onerror(event) {
                    if (done) return;
                    console.log("warning: browser could not fully decode audio " + name + ", trying slower base64 approach");

                    function encode64(data) {
                        var BASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
                        var PAD = "=";
                        var ret = "";
                        var leftchar = 0;
                        var leftbits = 0;
                        for (var i = 0; i < data.length; i++) {
                            leftchar = leftchar << 8 | data[i];
                            leftbits += 8;
                            while (leftbits >= 6) {
                                var curr = leftchar >> leftbits - 6 & 63;
                                leftbits -= 6;
                                ret += BASE[curr]
                            }
                        }
                        if (leftbits == 2) {
                            ret += BASE[(leftchar & 3) << 4];
                            ret += PAD + PAD
                        } else if (leftbits == 4) {
                            ret += BASE[(leftchar & 15) << 2];
                            ret += PAD
                        }
                        return ret
                    }
                    audio.src = "data:audio/x-" + name.substr(-3) + ";base64," + encode64(byteArray);
                    finish(audio)
                };
                audio.src = url;
                Browser.safeSetTimeout((function() { finish(audio) }), 1e4)
            } else { return fail() }
        };
        Module["preloadPlugins"].push(audioPlugin);

        function pointerLockChange() { Browser.pointerLock = document["pointerLockElement"] === Module["canvas"] || document["mozPointerLockElement"] === Module["canvas"] || document["webkitPointerLockElement"] === Module["canvas"] || document["msPointerLockElement"] === Module["canvas"] }
        var canvas = Module["canvas"];
        if (canvas) {
            canvas.requestPointerLock = canvas["requestPointerLock"] || canvas["mozRequestPointerLock"] || canvas["webkitRequestPointerLock"] || canvas["msRequestPointerLock"] || (function() {});
            canvas.exitPointerLock = document["exitPointerLock"] || document["mozExitPointerLock"] || document["webkitExitPointerLock"] || document["msExitPointerLock"] || (function() {});
            canvas.exitPointerLock = canvas.exitPointerLock.bind(document);
            document.addEventListener("pointerlockchange", pointerLockChange, false);
            document.addEventListener("mozpointerlockchange", pointerLockChange, false);
            document.addEventListener("webkitpointerlockchange", pointerLockChange, false);
            document.addEventListener("mspointerlockchange", pointerLockChange, false);
            if (Module["elementPointerLock"]) {
                canvas.addEventListener("click", (function(ev) {
                    if (!Browser.pointerLock && Module["canvas"].requestPointerLock) {
                        Module["canvas"].requestPointerLock();
                        ev.preventDefault()
                    }
                }), false)
            }
        }
    }),
    createContext: (function(canvas, useWebGL, setInModule, webGLContextAttributes) {
        if (useWebGL && Module.ctx && canvas == Module.canvas) return Module.ctx;
        var ctx;
        var contextHandle;
        if (useWebGL) {
            var contextAttributes = { antialias: false, alpha: false };
            if (webGLContextAttributes) { for (var attribute in webGLContextAttributes) { contextAttributes[attribute] = webGLContextAttributes[attribute] } }
            contextHandle = GL.createContext(canvas, contextAttributes);
            if (contextHandle) { ctx = GL.getContext(contextHandle).GLctx }
        } else { ctx = canvas.getContext("2d") }
        if (!ctx) return null;
        if (setInModule) {
            if (!useWebGL) assert(typeof GLctx === "undefined", "cannot set in module if GLctx is used, but we are a non-GL context that would replace it");
            Module.ctx = ctx;
            if (useWebGL) GL.makeContextCurrent(contextHandle);
            Module.useWebGL = useWebGL;
            Browser.moduleContextCreatedCallbacks.forEach((function(callback) { callback() }));
            Browser.init()
        }
        return ctx
    }),
    destroyContext: (function(canvas, useWebGL, setInModule) {}),
    fullscreenHandlersInstalled: false,
    lockPointer: undefined,
    resizeCanvas: undefined,
    requestFullscreen: (function(lockPointer, resizeCanvas, vrDevice) {
        Browser.lockPointer = lockPointer;
        Browser.resizeCanvas = resizeCanvas;
        Browser.vrDevice = vrDevice;
        if (typeof Browser.lockPointer === "undefined") Browser.lockPointer = true;
        if (typeof Browser.resizeCanvas === "undefined") Browser.resizeCanvas = false;
        if (typeof Browser.vrDevice === "undefined") Browser.vrDevice = null;
        var canvas = Module["canvas"];

        function fullscreenChange() {
            Browser.isFullscreen = false;
            var canvasContainer = canvas.parentNode;
            if ((document["fullscreenElement"] || document["mozFullScreenElement"] || document["msFullscreenElement"] || document["webkitFullscreenElement"] || document["webkitCurrentFullScreenElement"]) === canvasContainer) {
                canvas.exitFullscreen = document["exitFullscreen"] || document["cancelFullScreen"] || document["mozCancelFullScreen"] || document["msExitFullscreen"] || document["webkitCancelFullScreen"] || (function() {});
                canvas.exitFullscreen = canvas.exitFullscreen.bind(document);
                if (Browser.lockPointer) canvas.requestPointerLock();
                Browser.isFullscreen = true;
                if (Browser.resizeCanvas) { Browser.setFullscreenCanvasSize() } else { Browser.updateCanvasDimensions(canvas) }
            } else {
                canvasContainer.parentNode.insertBefore(canvas, canvasContainer);
                canvasContainer.parentNode.removeChild(canvasContainer);
                if (Browser.resizeCanvas) { Browser.setWindowedCanvasSize() } else { Browser.updateCanvasDimensions(canvas) }
            }
            if (Module["onFullScreen"]) Module["onFullScreen"](Browser.isFullscreen);
            if (Module["onFullscreen"]) Module["onFullscreen"](Browser.isFullscreen)
        }
        if (!Browser.fullscreenHandlersInstalled) {
            Browser.fullscreenHandlersInstalled = true;
            document.addEventListener("fullscreenchange", fullscreenChange, false);
            document.addEventListener("mozfullscreenchange", fullscreenChange, false);
            document.addEventListener("webkitfullscreenchange", fullscreenChange, false);
            document.addEventListener("MSFullscreenChange", fullscreenChange, false)
        }
        var canvasContainer = document.createElement("div");
        canvas.parentNode.insertBefore(canvasContainer, canvas);
        canvasContainer.appendChild(canvas);
        canvasContainer.requestFullscreen = canvasContainer["requestFullscreen"] || canvasContainer["mozRequestFullScreen"] || canvasContainer["msRequestFullscreen"] || (canvasContainer["webkitRequestFullscreen"] ? (function() { canvasContainer["webkitRequestFullscreen"](Element["ALLOW_KEYBOARD_INPUT"]) }) : null) || (canvasContainer["webkitRequestFullScreen"] ? (function() { canvasContainer["webkitRequestFullScreen"](Element["ALLOW_KEYBOARD_INPUT"]) }) : null);
        if (vrDevice) { canvasContainer.requestFullscreen({ vrDisplay: vrDevice }) } else { canvasContainer.requestFullscreen() }
    }),
    requestFullScreen: (function(lockPointer, resizeCanvas, vrDevice) {
        err("Browser.requestFullScreen() is deprecated. Please call Browser.requestFullscreen instead.");
        Browser.requestFullScreen = (function(lockPointer, resizeCanvas, vrDevice) { return Browser.requestFullscreen(lockPointer, resizeCanvas, vrDevice) });
        return Browser.requestFullscreen(lockPointer, resizeCanvas, vrDevice)
    }),
    nextRAF: 0,
    fakeRequestAnimationFrame: (function(func) {
        var now = Date.now();
        if (Browser.nextRAF === 0) { Browser.nextRAF = now + 1e3 / 60 } else { while (now + 2 >= Browser.nextRAF) { Browser.nextRAF += 1e3 / 60 } }
        var delay = Math.max(Browser.nextRAF - now, 0);
        setTimeout(func, delay)
    }),
    requestAnimationFrame: function requestAnimationFrame(func) {
        if (typeof window === "undefined") { Browser.fakeRequestAnimationFrame(func) } else {
            if (!window.requestAnimationFrame) { window.requestAnimationFrame = window["requestAnimationFrame"] || window["mozRequestAnimationFrame"] || window["webkitRequestAnimationFrame"] || window["msRequestAnimationFrame"] || window["oRequestAnimationFrame"] || Browser.fakeRequestAnimationFrame }
            window.requestAnimationFrame(func)
        }
    },
    safeCallback: (function(func) { return (function() { if (!ABORT) return func.apply(null, arguments) }) }),
    allowAsyncCallbacks: true,
    queuedAsyncCallbacks: [],
    pauseAsyncCallbacks: (function() { Browser.allowAsyncCallbacks = false }),
    resumeAsyncCallbacks: (function() {
        Browser.allowAsyncCallbacks = true;
        if (Browser.queuedAsyncCallbacks.length > 0) {
            var callbacks = Browser.queuedAsyncCallbacks;
            Browser.queuedAsyncCallbacks = [];
            callbacks.forEach((function(func) { func() }))
        }
    }),
    safeRequestAnimationFrame: (function(func) { return Browser.requestAnimationFrame((function() { if (ABORT) return; if (Browser.allowAsyncCallbacks) { func() } else { Browser.queuedAsyncCallbacks.push(func) } })) }),
    safeSetTimeout: (function(func, timeout) { Module["noExitRuntime"] = true; return setTimeout((function() { if (ABORT) return; if (Browser.allowAsyncCallbacks) { func() } else { Browser.queuedAsyncCallbacks.push(func) } }), timeout) }),
    safeSetInterval: (function(func, timeout) { Module["noExitRuntime"] = true; return setInterval((function() { if (ABORT) return; if (Browser.allowAsyncCallbacks) { func() } }), timeout) }),
    getMimetype: (function(name) { return { "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "bmp": "image/bmp", "ogg": "audio/ogg", "wav": "audio/wav", "mp3": "audio/mpeg" }[name.substr(name.lastIndexOf(".") + 1)] }),
    getUserMedia: (function(func) {
        if (!window.getUserMedia) { window.getUserMedia = navigator["getUserMedia"] || navigator["mozGetUserMedia"] }
        window.getUserMedia(func)
    }),
    getMovementX: (function(event) { return event["movementX"] || event["mozMovementX"] || event["webkitMovementX"] || 0 }),
    getMovementY: (function(event) { return event["movementY"] || event["mozMovementY"] || event["webkitMovementY"] || 0 }),
    getMouseWheelDelta: (function(event) {
        var delta = 0;
        switch (event.type) {
            case "DOMMouseScroll":
                delta = event.detail;
                break;
            case "mousewheel":
                delta = event.wheelDelta;
                break;
            case "wheel":
                delta = event["deltaY"];
                break;
            default:
                throw "unrecognized mouse wheel event: " + event.type
        }
        return delta
    }),
    mouseX: 0,
    mouseY: 0,
    mouseMovementX: 0,
    mouseMovementY: 0,
    touches: {},
    lastTouches: {},
    calculateMouseEvent: (function(event) {
        if (Browser.pointerLock) {
            if (event.type != "mousemove" && "mozMovementX" in event) { Browser.mouseMovementX = Browser.mouseMovementY = 0 } else {
                Browser.mouseMovementX = Browser.getMovementX(event);
                Browser.mouseMovementY = Browser.getMovementY(event)
            }
            if (typeof SDL != "undefined") {
                Browser.mouseX = SDL.mouseX + Browser.mouseMovementX;
                Browser.mouseY = SDL.mouseY + Browser.mouseMovementY
            } else {
                Browser.mouseX += Browser.mouseMovementX;
                Browser.mouseY += Browser.mouseMovementY
            }
        } else {
            var rect = Module["canvas"].getBoundingClientRect();
            var cw = Module["canvas"].width;
            var ch = Module["canvas"].height;
            var scrollX = typeof window.scrollX !== "undefined" ? window.scrollX : window.pageXOffset;
            var scrollY = typeof window.scrollY !== "undefined" ? window.scrollY : window.pageYOffset;
            if (event.type === "touchstart" || event.type === "touchend" || event.type === "touchmove") {
                var touch = event.touch;
                if (touch === undefined) { return }
                var adjustedX = touch.pageX - (scrollX + rect.left);
                var adjustedY = touch.pageY - (scrollY + rect.top);
                adjustedX = adjustedX * (cw / rect.width);
                adjustedY = adjustedY * (ch / rect.height);
                var coords = { x: adjustedX, y: adjustedY };
                if (event.type === "touchstart") {
                    Browser.lastTouches[touch.identifier] = coords;
                    Browser.touches[touch.identifier] = coords
                } else if (event.type === "touchend" || event.type === "touchmove") {
                    var last = Browser.touches[touch.identifier];
                    if (!last) last = coords;
                    Browser.lastTouches[touch.identifier] = last;
                    Browser.touches[touch.identifier] = coords
                }
                return
            }
            var x = event.pageX - (scrollX + rect.left);
            var y = event.pageY - (scrollY + rect.top);
            x = x * (cw / rect.width);
            y = y * (ch / rect.height);
            Browser.mouseMovementX = x - Browser.mouseX;
            Browser.mouseMovementY = y - Browser.mouseY;
            Browser.mouseX = x;
            Browser.mouseY = y
        }
    }),
    asyncLoad: (function(url, onload, onerror, noRunDep) {
        var dep = !noRunDep ? getUniqueRunDependency("al " + url) : "";
        Module["readAsync"](url, (function(arrayBuffer) {
            assert(arrayBuffer, 'Loading data file "' + url + '" failed (no arrayBuffer).');
            onload(new Uint8Array(arrayBuffer));
            if (dep) removeRunDependency(dep)
        }), (function(event) { if (onerror) { onerror() } else { throw 'Loading data file "' + url + '" failed.' } }));
        if (dep) addRunDependency(dep)
    }),
    resizeListeners: [],
    updateResizeListeners: (function() {
        var canvas = Module["canvas"];
        Browser.resizeListeners.forEach((function(listener) { listener(canvas.width, canvas.height) }))
    }),
    setCanvasSize: (function(width, height, noUpdates) {
        var canvas = Module["canvas"];
        Browser.updateCanvasDimensions(canvas, width, height);
        if (!noUpdates) Browser.updateResizeListeners()
    }),
    windowedWidth: 0,
    windowedHeight: 0,
    setFullscreenCanvasSize: (function() {
        if (typeof SDL != "undefined") {
            var flags = HEAPU32[SDL.screen >> 2];
            flags = flags | 8388608;
            HEAP32[SDL.screen >> 2] = flags
        }
        Browser.updateCanvasDimensions(Module["canvas"]);
        Browser.updateResizeListeners()
    }),
    setWindowedCanvasSize: (function() {
        if (typeof SDL != "undefined") {
            var flags = HEAPU32[SDL.screen >> 2];
            flags = flags & ~8388608;
            HEAP32[SDL.screen >> 2] = flags
        }
        Browser.updateCanvasDimensions(Module["canvas"]);
        Browser.updateResizeListeners()
    }),
    updateCanvasDimensions: (function(canvas, wNative, hNative) {
        if (wNative && hNative) {
            canvas.widthNative = wNative;
            canvas.heightNative = hNative
        } else {
            wNative = canvas.widthNative;
            hNative = canvas.heightNative
        }
        var w = wNative;
        var h = hNative;
        if (Module["forcedAspectRatio"] && Module["forcedAspectRatio"] > 0) { if (w / h < Module["forcedAspectRatio"]) { w = Math.round(h * Module["forcedAspectRatio"]) } else { h = Math.round(w / Module["forcedAspectRatio"]) } }
        if ((document["fullscreenElement"] || document["mozFullScreenElement"] || document["msFullscreenElement"] || document["webkitFullscreenElement"] || document["webkitCurrentFullScreenElement"]) === canvas.parentNode && typeof screen != "undefined") {
            var factor = Math.min(screen.width / w, screen.height / h);
            w = Math.round(w * factor);
            h = Math.round(h * factor)
        }
        if (Browser.resizeCanvas) {
            if (canvas.width != w) canvas.width = w;
            if (canvas.height != h) canvas.height = h;
            if (typeof canvas.style != "undefined") {
                canvas.style.removeProperty("width");
                canvas.style.removeProperty("height")
            }
        } else {
            if (canvas.width != wNative) canvas.width = wNative;
            if (canvas.height != hNative) canvas.height = hNative;
            if (typeof canvas.style != "undefined") {
                if (w != wNative || h != hNative) {
                    canvas.style.setProperty("width", w + "px", "important");
                    canvas.style.setProperty("height", h + "px", "important")
                } else {
                    canvas.style.removeProperty("width");
                    canvas.style.removeProperty("height")
                }
            }
        }
    }),
    wgetRequests: {},
    nextWgetRequestHandle: 0,
    getNextWgetRequestHandle: (function() {
        var handle = Browser.nextWgetRequestHandle;
        Browser.nextWgetRequestHandle++;
        return handle
    })
};
var EGL = {
    errorCode: 12288,
    defaultDisplayInitialized: false,
    currentContext: 0,
    currentReadSurface: 0,
    currentDrawSurface: 0,
    alpha: false,
    depth: true,
    stencil: true,
    antialias: true,
    stringCache: {},
    setErrorCode: (function(code) { EGL.errorCode = code }),
    chooseConfig: (function(display, attribList, config, config_size, numConfigs) {
        if (display != 62e3) { EGL.setErrorCode(12296); return 0 }
        if (attribList) {
            for (;;) {
                var param = HEAP32[attribList >> 2];
                if (param == 12321) {
                    var alphaSize = HEAP32[attribList + 4 >> 2];
                    EGL.alpha = alphaSize > 0
                } else if (param == 12325) {
                    var depthSize = HEAP32[attribList + 4 >> 2];
                    EGL.depth = depthSize > 0
                } else if (param == 12326) {
                    var stencilSize = HEAP32[attribList + 4 >> 2];
                    EGL.stencil = stencilSize > 0
                } else if (param == 12337) {
                    var samples = HEAP32[attribList + 4 >> 2];
                    EGL.antialias = samples > 0
                } else if (param == 12338) {
                    var samples = HEAP32[attribList + 4 >> 2];
                    EGL.antialias = samples == 1
                } else if (param == 12344) { break }
                attribList += 8
            }
        }
        if ((!config || !config_size) && !numConfigs) { EGL.setErrorCode(12300); return 0 }
        if (numConfigs) { HEAP32[numConfigs >> 2] = 1 }
        if (config && config_size > 0) { HEAP32[config >> 2] = 62002 }
        EGL.setErrorCode(12288);
        return 1
    })
};

function _eglBindAPI(api) { if (api == 12448) { EGL.setErrorCode(12288); return 1 } else { EGL.setErrorCode(12300); return 0 } }

function _eglChooseConfig(display, attrib_list, configs, config_size, numConfigs) { return EGL.chooseConfig(display, attrib_list, configs, config_size, numConfigs) }
var GLUT = {
    initTime: null,
    idleFunc: null,
    displayFunc: null,
    keyboardFunc: null,
    keyboardUpFunc: null,
    specialFunc: null,
    specialUpFunc: null,
    reshapeFunc: null,
    motionFunc: null,
    passiveMotionFunc: null,
    mouseFunc: null,
    buttons: 0,
    modifiers: 0,
    initWindowWidth: 256,
    initWindowHeight: 256,
    initDisplayMode: 18,
    windowX: 0,
    windowY: 0,
    windowWidth: 0,
    windowHeight: 0,
    requestedAnimationFrame: false,
    saveModifiers: (function(event) { GLUT.modifiers = 0; if (event["shiftKey"]) GLUT.modifiers += 1; if (event["ctrlKey"]) GLUT.modifiers += 2; if (event["altKey"]) GLUT.modifiers += 4 }),
    onMousemove: (function(event) {
        var lastX = Browser.mouseX;
        var lastY = Browser.mouseY;
        Browser.calculateMouseEvent(event);
        var newX = Browser.mouseX;
        var newY = Browser.mouseY;
        if (newX == lastX && newY == lastY) return;
        if (GLUT.buttons == 0 && event.target == Module["canvas"] && GLUT.passiveMotionFunc) {
            event.preventDefault();
            GLUT.saveModifiers(event);
            Module["dynCall_vii"](GLUT.passiveMotionFunc, lastX, lastY)
        } else if (GLUT.buttons != 0 && GLUT.motionFunc) {
            event.preventDefault();
            GLUT.saveModifiers(event);
            Module["dynCall_vii"](GLUT.motionFunc, lastX, lastY)
        }
    }),
    getSpecialKey: (function(keycode) {
        var key = null;
        switch (keycode) {
            case 8:
                key = 120;
                break;
            case 46:
                key = 111;
                break;
            case 112:
                key = 1;
                break;
            case 113:
                key = 2;
                break;
            case 114:
                key = 3;
                break;
            case 115:
                key = 4;
                break;
            case 116:
                key = 5;
                break;
            case 117:
                key = 6;
                break;
            case 118:
                key = 7;
                break;
            case 119:
                key = 8;
                break;
            case 120:
                key = 9;
                break;
            case 121:
                key = 10;
                break;
            case 122:
                key = 11;
                break;
            case 123:
                key = 12;
                break;
            case 37:
                key = 100;
                break;
            case 38:
                key = 101;
                break;
            case 39:
                key = 102;
                break;
            case 40:
                key = 103;
                break;
            case 33:
                key = 104;
                break;
            case 34:
                key = 105;
                break;
            case 36:
                key = 106;
                break;
            case 35:
                key = 107;
                break;
            case 45:
                key = 108;
                break;
            case 16:
            case 5:
                key = 112;
                break;
            case 6:
                key = 113;
                break;
            case 17:
            case 3:
                key = 114;
                break;
            case 4:
                key = 115;
                break;
            case 18:
            case 2:
                key = 116;
                break;
            case 1:
                key = 117;
                break
        }
        return key
    }),
    getASCIIKey: (function(event) {
        if (event["ctrlKey"] || event["altKey"] || event["metaKey"]) return null;
        var keycode = event["keyCode"];
        if (48 <= keycode && keycode <= 57) return keycode;
        if (65 <= keycode && keycode <= 90) return event["shiftKey"] ? keycode : keycode + 32;
        if (96 <= keycode && keycode <= 105) return keycode - 48;
        if (106 <= keycode && keycode <= 111) return keycode - 106 + 42;
        switch (keycode) {
            case 9:
            case 13:
            case 27:
            case 32:
            case 61:
                return keycode
        }
        var s = event["shiftKey"];
        switch (keycode) {
            case 186:
                return s ? 58 : 59;
            case 187:
                return s ? 43 : 61;
            case 188:
                return s ? 60 : 44;
            case 189:
                return s ? 95 : 45;
            case 190:
                return s ? 62 : 46;
            case 191:
                return s ? 63 : 47;
            case 219:
                return s ? 123 : 91;
            case 220:
                return s ? 124 : 47;
            case 221:
                return s ? 125 : 93;
            case 222:
                return s ? 34 : 39
        }
        return null
    }),
    onKeydown: (function(event) {
        if (GLUT.specialFunc || GLUT.keyboardFunc) {
            var key = GLUT.getSpecialKey(event["keyCode"]);
            if (key !== null) {
                if (GLUT.specialFunc) {
                    event.preventDefault();
                    GLUT.saveModifiers(event);
                    Module["dynCall_viii"](GLUT.specialFunc, key, Browser.mouseX, Browser.mouseY)
                }
            } else {
                key = GLUT.getASCIIKey(event);
                if (key !== null && GLUT.keyboardFunc) {
                    event.preventDefault();
                    GLUT.saveModifiers(event);
                    Module["dynCall_viii"](GLUT.keyboardFunc, key, Browser.mouseX, Browser.mouseY)
                }
            }
        }
    }),
    onKeyup: (function(event) {
        if (GLUT.specialUpFunc || GLUT.keyboardUpFunc) {
            var key = GLUT.getSpecialKey(event["keyCode"]);
            if (key !== null) {
                if (GLUT.specialUpFunc) {
                    event.preventDefault();
                    GLUT.saveModifiers(event);
                    Module["dynCall_viii"](GLUT.specialUpFunc, key, Browser.mouseX, Browser.mouseY)
                }
            } else {
                key = GLUT.getASCIIKey(event);
                if (key !== null && GLUT.keyboardUpFunc) {
                    event.preventDefault();
                    GLUT.saveModifiers(event);
                    Module["dynCall_viii"](GLUT.keyboardUpFunc, key, Browser.mouseX, Browser.mouseY)
                }
            }
        }
    }),
    touchHandler: (function(event) {
        if (event.target != Module["canvas"]) { return }
        var touches = event.changedTouches,
            main = touches[0],
            type = "";
        switch (event.type) {
            case "touchstart":
                type = "mousedown";
                break;
            case "touchmove":
                type = "mousemove";
                break;
            case "touchend":
                type = "mouseup";
                break;
            default:
                return
        }
        var simulatedEvent = document.createEvent("MouseEvent");
        simulatedEvent.initMouseEvent(type, true, true, window, 1, main.screenX, main.screenY, main.clientX, main.clientY, false, false, false, false, 0, null);
        main.target.dispatchEvent(simulatedEvent);
        event.preventDefault()
    }),
    onMouseButtonDown: (function(event) {
        Browser.calculateMouseEvent(event);
        GLUT.buttons |= 1 << event["button"];
        if (event.target == Module["canvas"] && GLUT.mouseFunc) {
            try { event.target.setCapture() } catch (e) {}
            event.preventDefault();
            GLUT.saveModifiers(event);
            Module["dynCall_viiii"](GLUT.mouseFunc, event["button"], 0, Browser.mouseX, Browser.mouseY)
        }
    }),
    onMouseButtonUp: (function(event) {
        Browser.calculateMouseEvent(event);
        GLUT.buttons &= ~(1 << event["button"]);
        if (GLUT.mouseFunc) {
            event.preventDefault();
            GLUT.saveModifiers(event);
            Module["dynCall_viiii"](GLUT.mouseFunc, event["button"], 1, Browser.mouseX, Browser.mouseY)
        }
    }),
    onMouseWheel: (function(event) {
        Browser.calculateMouseEvent(event);
        var e = window.event || event;
        var delta = -Browser.getMouseWheelDelta(event);
        delta = delta == 0 ? 0 : delta > 0 ? Math.max(delta, 1) : Math.min(delta, -1);
        var button = 3;
        if (delta < 0) { button = 4 }
        if (GLUT.mouseFunc) {
            event.preventDefault();
            GLUT.saveModifiers(event);
            Module["dynCall_viiii"](GLUT.mouseFunc, button, 0, Browser.mouseX, Browser.mouseY)
        }
    }),
    onFullscreenEventChange: (function(event) {
        var width;
        var height;
        if (document["fullscreen"] || document["fullScreen"] || document["mozFullScreen"] || document["webkitIsFullScreen"]) {
            width = screen["width"];
            height = screen["height"]
        } else {
            width = GLUT.windowWidth;
            height = GLUT.windowHeight;
            document.removeEventListener("fullscreenchange", GLUT.onFullscreenEventChange, true);
            document.removeEventListener("mozfullscreenchange", GLUT.onFullscreenEventChange, true);
            document.removeEventListener("webkitfullscreenchange", GLUT.onFullscreenEventChange, true)
        }
        Browser.setCanvasSize(width, height, true);
        if (GLUT.reshapeFunc) { Module["dynCall_vii"](GLUT.reshapeFunc, width, height) }
        _glutPostRedisplay()
    }),
    requestFullscreen: (function() { Browser.requestFullscreen(false, false) }),
    requestFullScreen: (function() {
        err("GLUT.requestFullScreen() is deprecated. Please call GLUT.requestFullscreen instead.");
        GLUT.requestFullScreen = (function() { return GLUT.requestFullscreen() });
        return GLUT.requestFullscreen()
    }),
    exitFullscreen: (function() {
        var CFS = document["exitFullscreen"] || document["cancelFullScreen"] || document["mozCancelFullScreen"] || document["webkitCancelFullScreen"] || (function() {});
        CFS.apply(document, [])
    }),
    cancelFullScreen: (function() {
        err("GLUT.cancelFullScreen() is deprecated. Please call GLUT.exitFullscreen instead.");
        GLUT.cancelFullScreen = (function() { return GLUT.exitFullscreen() });
        return GLUT.exitFullscreen()
    })
};

function _glutInitDisplayMode(mode) { GLUT.initDisplayMode = mode }

function _glutCreateWindow(name) {
    var contextAttributes = { antialias: (GLUT.initDisplayMode & 128) != 0, depth: (GLUT.initDisplayMode & 16) != 0, stencil: (GLUT.initDisplayMode & 32) != 0, alpha: (GLUT.initDisplayMode & 8) != 0 };
    Module.ctx = Browser.createContext(Module["canvas"], true, true, contextAttributes);
    return Module.ctx ? 1 : 0
}
var GL = {
    counter: 1,
    lastError: 0,
    buffers: [],
    mappedBuffers: {},
    programs: [],
    framebuffers: [],
    renderbuffers: [],
    textures: [],
    uniforms: [],
    shaders: [],
    vaos: [],
    contexts: {},
    currentContext: null,
    offscreenCanvases: {},
    timerQueriesEXT: [],
    byteSizeByTypeRoot: 5120,
    byteSizeByType: [1, 1, 2, 2, 4, 4, 4, 2, 3, 4, 8],
    programInfos: {},
    stringCache: {},
    tempFixedLengthArray: [],
    packAlignment: 4,
    unpackAlignment: 4,
    init: (function() { GL.miniTempBuffer = new Float32Array(GL.MINI_TEMP_BUFFER_SIZE); for (var i = 0; i < GL.MINI_TEMP_BUFFER_SIZE; i++) { GL.miniTempBufferViews[i] = GL.miniTempBuffer.subarray(0, i + 1) } for (var i = 0; i < 32; i++) { GL.tempFixedLengthArray.push(new Array(i)) } }),
    recordError: function recordError(errorCode) { if (!GL.lastError) { GL.lastError = errorCode } },
    getNewId: (function(table) { var ret = GL.counter++; for (var i = table.length; i < ret; i++) { table[i] = null } return ret }),
    MINI_TEMP_BUFFER_SIZE: 256,
    miniTempBuffer: null,
    miniTempBufferViews: [0],
    getSource: (function(shader, count, string, length) {
        var source = "";
        for (var i = 0; i < count; ++i) {
            var frag;
            if (length) { var len = HEAP32[length + i * 4 >> 2]; if (len < 0) { frag = Pointer_stringify(HEAP32[string + i * 4 >> 2]) } else { frag = Pointer_stringify(HEAP32[string + i * 4 >> 2], len) } } else { frag = Pointer_stringify(HEAP32[string + i * 4 >> 2]) }
            source += frag
        }
        return source
    }),
    createContext: (function(canvas, webGLContextAttributes) {
        if (typeof webGLContextAttributes["majorVersion"] === "undefined" && typeof webGLContextAttributes["minorVersion"] === "undefined") {
            webGLContextAttributes["majorVersion"] = 1;
            webGLContextAttributes["minorVersion"] = 0
        }
        var ctx;
        var errorInfo = "?";

        function onContextCreationError(event) { errorInfo = event.statusMessage || errorInfo }
        try { canvas.addEventListener("webglcontextcreationerror", onContextCreationError, false); try { if (webGLContextAttributes["majorVersion"] == 1 && webGLContextAttributes["minorVersion"] == 0) { ctx = canvas.getContext("webgl", webGLContextAttributes) || canvas.getContext("experimental-webgl", webGLContextAttributes) } else if (webGLContextAttributes["majorVersion"] == 2 && webGLContextAttributes["minorVersion"] == 0) { ctx = canvas.getContext("webgl2", webGLContextAttributes) } else { throw "Unsupported WebGL context version " + majorVersion + "." + minorVersion + "!" } } finally { canvas.removeEventListener("webglcontextcreationerror", onContextCreationError, false) } if (!ctx) throw ":(" } catch (e) { return 0 }
        if (!ctx) return 0;
        var context = GL.registerContext(ctx, webGLContextAttributes);
        return context
    }),
    registerContext: (function(ctx, webGLContextAttributes) {
        var handle = _malloc(8);
        HEAP32[handle >> 2] = webGLContextAttributes["explicitSwapControl"];
        var context = { handle: handle, attributes: webGLContextAttributes, version: webGLContextAttributes["majorVersion"], GLctx: ctx };
        if (ctx.canvas) ctx.canvas.GLctxObject = context;
        GL.contexts[handle] = context;
        if (typeof webGLContextAttributes["enableExtensionsByDefault"] === "undefined" || webGLContextAttributes["enableExtensionsByDefault"]) { GL.initExtensions(context) }
        return handle
    }),
    makeContextCurrent: (function(contextHandle) {
        if (!contextHandle) { GLctx = Module.ctx = GL.currentContext = null; return true }
        var context = GL.contexts[contextHandle];
        if (!context) { return false }
        GLctx = Module.ctx = context.GLctx;
        GL.currentContext = context;
        return true
    }),
    getContext: (function(contextHandle) { return GL.contexts[contextHandle] }),
    deleteContext: (function(contextHandle) {
        if (GL.currentContext === GL.contexts[contextHandle]) GL.currentContext = null;
        if (typeof JSEvents === "object") JSEvents.removeAllHandlersOnTarget(GL.contexts[contextHandle].GLctx.canvas);
        if (GL.contexts[contextHandle] && GL.contexts[contextHandle].GLctx.canvas) GL.contexts[contextHandle].GLctx.canvas.GLctxObject = undefined;
        _free(GL.contexts[contextHandle]);
        GL.contexts[contextHandle] = null
    }),
    initExtensions: (function(context) {
        if (!context) context = GL.currentContext;
        if (context.initExtensionsDone) return;
        context.initExtensionsDone = true;
        var GLctx = context.GLctx;
        if (context.version < 2) {
            var instancedArraysExt = GLctx.getExtension("ANGLE_instanced_arrays");
            if (instancedArraysExt) {
                GLctx["vertexAttribDivisor"] = (function(index, divisor) { instancedArraysExt["vertexAttribDivisorANGLE"](index, divisor) });
                GLctx["drawArraysInstanced"] = (function(mode, first, count, primcount) { instancedArraysExt["drawArraysInstancedANGLE"](mode, first, count, primcount) });
                GLctx["drawElementsInstanced"] = (function(mode, count, type, indices, primcount) { instancedArraysExt["drawElementsInstancedANGLE"](mode, count, type, indices, primcount) })
            }
            var vaoExt = GLctx.getExtension("OES_vertex_array_object");
            if (vaoExt) {
                GLctx["createVertexArray"] = (function() { return vaoExt["createVertexArrayOES"]() });
                GLctx["deleteVertexArray"] = (function(vao) { vaoExt["deleteVertexArrayOES"](vao) });
                GLctx["bindVertexArray"] = (function(vao) { vaoExt["bindVertexArrayOES"](vao) });
                GLctx["isVertexArray"] = (function(vao) { return vaoExt["isVertexArrayOES"](vao) })
            }
            var drawBuffersExt = GLctx.getExtension("WEBGL_draw_buffers");
            if (drawBuffersExt) { GLctx["drawBuffers"] = (function(n, bufs) { drawBuffersExt["drawBuffersWEBGL"](n, bufs) }) }
        }
        GLctx.disjointTimerQueryExt = GLctx.getExtension("EXT_disjoint_timer_query");
        var automaticallyEnabledExtensions = ["OES_texture_float", "OES_texture_half_float", "OES_standard_derivatives", "OES_vertex_array_object", "WEBGL_compressed_texture_s3tc", "WEBGL_depth_texture", "OES_element_index_uint", "EXT_texture_filter_anisotropic", "EXT_frag_depth", "WEBGL_draw_buffers", "ANGLE_instanced_arrays", "OES_texture_float_linear", "OES_texture_half_float_linear", "EXT_blend_minmax", "EXT_shader_texture_lod", "WEBGL_compressed_texture_pvrtc", "EXT_color_buffer_half_float", "WEBGL_color_buffer_float", "EXT_sRGB", "WEBGL_compressed_texture_etc1", "EXT_disjoint_timer_query", "WEBGL_compressed_texture_etc", "WEBGL_compressed_texture_astc", "EXT_color_buffer_float", "WEBGL_compressed_texture_s3tc_srgb", "EXT_disjoint_timer_query_webgl2"];
        var exts = GLctx.getSupportedExtensions();
        if (exts && exts.length > 0) { GLctx.getSupportedExtensions().forEach((function(ext) { if (automaticallyEnabledExtensions.indexOf(ext) != -1) { GLctx.getExtension(ext) } })) }
    }),
    populateUniformTable: (function(program) {
        var p = GL.programs[program];
        GL.programInfos[program] = { uniforms: {}, maxUniformLength: 0, maxAttributeLength: -1, maxUniformBlockNameLength: -1 };
        var ptable = GL.programInfos[program];
        var utable = ptable.uniforms;
        var numUniforms = GLctx.getProgramParameter(p, GLctx.ACTIVE_UNIFORMS);
        for (var i = 0; i < numUniforms; ++i) {
            var u = GLctx.getActiveUniform(p, i);
            var name = u.name;
            ptable.maxUniformLength = Math.max(ptable.maxUniformLength, name.length + 1);
            if (name.indexOf("]", name.length - 1) !== -1) {
                var ls = name.lastIndexOf("[");
                name = name.slice(0, ls)
            }
            var loc = GLctx.getUniformLocation(p, name);
            if (loc != null) {
                var id = GL.getNewId(GL.uniforms);
                utable[name] = [u.size, id];
                GL.uniforms[id] = loc;
                for (var j = 1; j < u.size; ++j) {
                    var n = name + "[" + j + "]";
                    loc = GLctx.getUniformLocation(p, n);
                    id = GL.getNewId(GL.uniforms);
                    GL.uniforms[id] = loc
                }
            }
        }
    })
};

function _eglCreateContext(display, config, hmm, contextAttribs) {
    if (display != 62e3) { EGL.setErrorCode(12296); return 0 }
    var glesContextVersion = 1;
    for (;;) {
        var param = HEAP32[contextAttribs >> 2];
        if (param == 12440) { glesContextVersion = HEAP32[contextAttribs + 4 >> 2] } else if (param == 12344) { break } else { EGL.setErrorCode(12292); return 0 }
        contextAttribs += 8
    }
    if (glesContextVersion != 2) { EGL.setErrorCode(12293); return 0 }
    var displayMode = 0;
    displayMode |= 2;
    if (EGL.alpha) displayMode |= 8;
    if (EGL.depth) displayMode |= 16;
    if (EGL.stencil) displayMode |= 32;
    if (EGL.antialias) displayMode |= 128;
    _glutInitDisplayMode(displayMode);
    EGL.windowID = _glutCreateWindow();
    if (EGL.windowID != 0) { EGL.setErrorCode(12288); return 62004 } else { EGL.setErrorCode(12297); return 0 }
}

function _eglCreateWindowSurface(display, config, win, attrib_list) {
    if (display != 62e3) { EGL.setErrorCode(12296); return 0 }
    if (config != 62002) { EGL.setErrorCode(12293); return 0 }
    EGL.setErrorCode(12288);
    return 62006
}

function _eglDestroyContext(display, context) {
    if (display != 62e3) { EGL.setErrorCode(12296); return 0 }
    if (context != 62004) { EGL.setErrorCode(12294); return 0 }
    EGL.setErrorCode(12288);
    return 1
}

function _eglDestroySurface(display, surface) {
    if (display != 62e3) { EGL.setErrorCode(12296); return 0 }
    if (surface != 62006) { EGL.setErrorCode(12301); return 1 }
    if (EGL.currentReadSurface == surface) { EGL.currentReadSurface = 0 }
    if (EGL.currentDrawSurface == surface) { EGL.currentDrawSurface = 0 }
    EGL.setErrorCode(12288);
    return 1
}

function _eglGetConfigAttrib(display, config, attribute, value) {
    if (display != 62e3) { EGL.setErrorCode(12296); return 0 }
    if (config != 62002) { EGL.setErrorCode(12293); return 0 }
    if (!value) { EGL.setErrorCode(12300); return 0 }
    EGL.setErrorCode(12288);
    switch (attribute) {
        case 12320:
            HEAP32[value >> 2] = 32;
            return 1;
        case 12321:
            HEAP32[value >> 2] = 8;
            return 1;
        case 12322:
            HEAP32[value >> 2] = 8;
            return 1;
        case 12323:
            HEAP32[value >> 2] = 8;
            return 1;
        case 12324:
            HEAP32[value >> 2] = 8;
            return 1;
        case 12325:
            HEAP32[value >> 2] = 24;
            return 1;
        case 12326:
            HEAP32[value >> 2] = 8;
            return 1;
        case 12327:
            HEAP32[value >> 2] = 12344;
            return 1;
        case 12328:
            HEAP32[value >> 2] = 62002;
            return 1;
        case 12329:
            HEAP32[value >> 2] = 0;
            return 1;
        case 12330:
            HEAP32[value >> 2] = 4096;
            return 1;
        case 12331:
            HEAP32[value >> 2] = 16777216;
            return 1;
        case 12332:
            HEAP32[value >> 2] = 4096;
            return 1;
        case 12333:
            HEAP32[value >> 2] = 0;
            return 1;
        case 12334:
            HEAP32[value >> 2] = 0;
            return 1;
        case 12335:
            HEAP32[value >> 2] = 12344;
            return 1;
        case 12337:
            HEAP32[value >> 2] = 4;
            return 1;
        case 12338:
            HEAP32[value >> 2] = 1;
            return 1;
        case 12339:
            HEAP32[value >> 2] = 4;
            return 1;
        case 12340:
            HEAP32[value >> 2] = 12344;
            return 1;
        case 12341:
        case 12342:
        case 12343:
            HEAP32[value >> 2] = -1;
            return 1;
        case 12345:
        case 12346:
            HEAP32[value >> 2] = 0;
            return 1;
        case 12347:
        case 12348:
            HEAP32[value >> 2] = 1;
            return 1;
        case 12349:
        case 12350:
            HEAP32[value >> 2] = 0;
            return 1;
        case 12351:
            HEAP32[value >> 2] = 12430;
            return 1;
        case 12352:
            HEAP32[value >> 2] = 4;
            return 1;
        case 12354:
            HEAP32[value >> 2] = 0;
            return 1;
        default:
            EGL.setErrorCode(12292);
            return 0
    }
}

function _eglGetDisplay(nativeDisplayType) { EGL.setErrorCode(12288); return 62e3 }

function _eglGetError() { return EGL.errorCode }

function _eglGetProcAddress(name_) { return _emscripten_GetProcAddress(name_) }

function _eglInitialize(display, majorVersion, minorVersion) {
    if (display == 62e3) {
        if (majorVersion) { HEAP32[majorVersion >> 2] = 1 }
        if (minorVersion) { HEAP32[minorVersion >> 2] = 4 }
        EGL.defaultDisplayInitialized = true;
        EGL.setErrorCode(12288);
        return 1
    } else { EGL.setErrorCode(12296); return 0 }
}

function _eglMakeCurrent(display, draw, read, context) {
    if (display != 62e3) { EGL.setErrorCode(12296); return 0 }
    if (context != 0 && context != 62004) { EGL.setErrorCode(12294); return 0 }
    if (read != 0 && read != 62006 || draw != 0 && draw != 62006) { EGL.setErrorCode(12301); return 0 }
    EGL.currentContext = context;
    EGL.currentDrawSurface = draw;
    EGL.currentReadSurface = read;
    EGL.setErrorCode(12288);
    return 1
}

function _eglQueryString(display, name) {
    if (display != 62e3) { EGL.setErrorCode(12296); return 0 }
    EGL.setErrorCode(12288);
    if (EGL.stringCache[name]) return EGL.stringCache[name];
    var ret;
    switch (name) {
        case 12371:
            ret = allocate(intArrayFromString("Emscripten"), "i8", ALLOC_NORMAL);
            break;
        case 12372:
            ret = allocate(intArrayFromString("1.4 Emscripten EGL"), "i8", ALLOC_NORMAL);
            break;
        case 12373:
            ret = allocate(intArrayFromString(""), "i8", ALLOC_NORMAL);
            break;
        case 12429:
            ret = allocate(intArrayFromString("OpenGL_ES"), "i8", ALLOC_NORMAL);
            break;
        default:
            EGL.setErrorCode(12300);
            return 0
    }
    EGL.stringCache[name] = ret;
    return ret
}

function _eglSwapBuffers() { if (!EGL.defaultDisplayInitialized) { EGL.setErrorCode(12289) } else if (!Module.ctx) { EGL.setErrorCode(12290) } else if (Module.ctx.isContextLost()) { EGL.setErrorCode(12302) } else { EGL.setErrorCode(12288); return 1 } return 0 }

function _eglSwapInterval(display, interval) {
    if (display != 62e3) { EGL.setErrorCode(12296); return 0 }
    if (interval == 0) _emscripten_set_main_loop_timing(0, 0);
    else _emscripten_set_main_loop_timing(1, interval);
    EGL.setErrorCode(12288);
    return 1
}

function _eglTerminate(display) {
    if (display != 62e3) { EGL.setErrorCode(12296); return 0 }
    EGL.currentContext = 0;
    EGL.currentReadSurface = 0;
    EGL.currentDrawSurface = 0;
    EGL.defaultDisplayInitialized = false;
    EGL.setErrorCode(12288);
    return 1
}

function _eglWaitClient() { EGL.setErrorCode(12288); return 1 }

function _eglWaitGL() { return _eglWaitClient.apply(null, arguments) }

function _eglWaitNative(nativeEngineId) { EGL.setErrorCode(12288); return 1 }

function _emscripten_get_canvas_element_size(target, width, height) {
    var canvas = JSEvents.findCanvasEventTarget(target);
    if (!canvas) return -4;
    HEAP32[width >> 2] = canvas.width;
    HEAP32[height >> 2] = canvas.height
}

function __get_canvas_element_size(target) {
    var stackTop = stackSave();
    var w = stackAlloc(8);
    var h = w + 4;
    var targetInt = stackAlloc(target.id.length + 1);
    stringToUTF8(target.id, targetInt, target.id.length + 1);
    var ret = _emscripten_get_canvas_element_size(targetInt, w, h);
    var size = [HEAP32[w >> 2], HEAP32[h >> 2]];
    stackRestore(stackTop);
    return size
}

function _emscripten_set_canvas_element_size(target, width, height) {
    var canvas = JSEvents.findCanvasEventTarget(target);
    if (!canvas) return -4;
    canvas.width = width;
    canvas.height = height;
    return 0
}

function __set_canvas_element_size(target, width, height) {
    if (!target.controlTransferredOffscreen) {
        target.width = width;
        target.height = height
    } else {
        var stackTop = stackSave();
        var targetInt = stackAlloc(target.id.length + 1);
        stringToUTF8(target.id, targetInt, target.id.length + 1);
        _emscripten_set_canvas_element_size(targetInt, width, height);
        stackRestore(stackTop)
    }
}
var JSEvents = {
    keyEvent: 0,
    mouseEvent: 0,
    wheelEvent: 0,
    uiEvent: 0,
    focusEvent: 0,
    deviceOrientationEvent: 0,
    deviceMotionEvent: 0,
    fullscreenChangeEvent: 0,
    pointerlockChangeEvent: 0,
    visibilityChangeEvent: 0,
    touchEvent: 0,
    lastGamepadState: null,
    lastGamepadStateFrame: null,
    numGamepadsConnected: 0,
    previousFullscreenElement: null,
    previousScreenX: null,
    previousScreenY: null,
    removeEventListenersRegistered: false,
    _onGamepadConnected: (function() {++JSEvents.numGamepadsConnected }),
    _onGamepadDisconnected: (function() {--JSEvents.numGamepadsConnected }),
    staticInit: (function() {
        if (typeof window !== "undefined") {
            window.addEventListener("gamepadconnected", JSEvents._onGamepadConnected);
            window.addEventListener("gamepaddisconnected", JSEvents._onGamepadDisconnected);
            var firstState = navigator.getGamepads ? navigator.getGamepads() : navigator.webkitGetGamepads ? navigator.webkitGetGamepads() : null;
            if (firstState) { JSEvents.numGamepadsConnected = firstState.length }
        }
    }),
    removeAllEventListeners: (function() {
        for (var i = JSEvents.eventHandlers.length - 1; i >= 0; --i) { JSEvents._removeHandler(i) }
        JSEvents.eventHandlers = [];
        JSEvents.deferredCalls = [];
        if (typeof window !== "undefined") {
            window.removeEventListener("gamepadconnected", JSEvents._onGamepadConnected);
            window.removeEventListener("gamepaddisconnected", JSEvents._onGamepadDisconnected)
        }
    }),
    registerRemoveEventListeners: (function() {
        if (!JSEvents.removeEventListenersRegistered) {
            __ATEXIT__.push(JSEvents.removeAllEventListeners);
            JSEvents.removeEventListenersRegistered = true
        }
    }),
    findEventTarget: (function(target) {
        try {
            if (!target) return window;
            if (typeof target === "number") target = Pointer_stringify(target);
            if (target === "#window") return window;
            else if (target === "#document") return document;
            else if (target === "#screen") return window.screen;
            else if (target === "#canvas") return Module["canvas"];
            return typeof target === "string" ? document.getElementById(target) : target
        } catch (e) { return null }
    }),
    findCanvasEventTarget: (function(target) { if (typeof target === "number") target = Pointer_stringify(target); if (!target || target === "#canvas") { if (typeof GL !== "undefined" && GL.offscreenCanvases["canvas"]) return GL.offscreenCanvases["canvas"]; return Module["canvas"] } if (typeof GL !== "undefined" && GL.offscreenCanvases[target]) return GL.offscreenCanvases[target]; return JSEvents.findEventTarget(target) }),
    deferredCalls: [],
    deferCall: (function(targetFunction, precedence, argsList) {
        function arraysHaveEqualContent(arrA, arrB) { if (arrA.length != arrB.length) return false; for (var i in arrA) { if (arrA[i] != arrB[i]) return false } return true }
        for (var i in JSEvents.deferredCalls) { var call = JSEvents.deferredCalls[i]; if (call.targetFunction == targetFunction && arraysHaveEqualContent(call.argsList, argsList)) { return } }
        JSEvents.deferredCalls.push({ targetFunction: targetFunction, precedence: precedence, argsList: argsList });
        JSEvents.deferredCalls.sort((function(x, y) { return x.precedence < y.precedence }))
    }),
    removeDeferredCalls: (function(targetFunction) { for (var i = 0; i < JSEvents.deferredCalls.length; ++i) { if (JSEvents.deferredCalls[i].targetFunction == targetFunction) { JSEvents.deferredCalls.splice(i, 1);--i } } }),
    canPerformEventHandlerRequests: (function() { return JSEvents.inEventHandler && JSEvents.currentEventHandler.allowsDeferredCalls }),
    runDeferredCalls: (function() {
        if (!JSEvents.canPerformEventHandlerRequests()) { return }
        for (var i = 0; i < JSEvents.deferredCalls.length; ++i) {
            var call = JSEvents.deferredCalls[i];
            JSEvents.deferredCalls.splice(i, 1);
            --i;
            call.targetFunction.apply(this, call.argsList)
        }
    }),
    inEventHandler: 0,
    currentEventHandler: null,
    eventHandlers: [],
    isInternetExplorer: (function() { return navigator.userAgent.indexOf("MSIE") !== -1 || navigator.appVersion.indexOf("Trident/") > 0 }),
    removeAllHandlersOnTarget: (function(target, eventTypeString) { for (var i = 0; i < JSEvents.eventHandlers.length; ++i) { if (JSEvents.eventHandlers[i].target == target && (!eventTypeString || eventTypeString == JSEvents.eventHandlers[i].eventTypeString)) { JSEvents._removeHandler(i--) } } }),
    _removeHandler: (function(i) {
        var h = JSEvents.eventHandlers[i];
        h.target.removeEventListener(h.eventTypeString, h.eventListenerFunc, h.useCapture);
        JSEvents.eventHandlers.splice(i, 1)
    }),
    registerOrRemoveHandler: (function(eventHandler) {
        var jsEventHandler = function jsEventHandler(event) {
            ++JSEvents.inEventHandler;
            JSEvents.currentEventHandler = eventHandler;
            JSEvents.runDeferredCalls();
            eventHandler.handlerFunc(event);
            JSEvents.runDeferredCalls();
            --JSEvents.inEventHandler
        };
        if (eventHandler.callbackfunc) {
            eventHandler.eventListenerFunc = jsEventHandler;
            eventHandler.target.addEventListener(eventHandler.eventTypeString, jsEventHandler, eventHandler.useCapture);
            JSEvents.eventHandlers.push(eventHandler);
            JSEvents.registerRemoveEventListeners()
        } else { for (var i = 0; i < JSEvents.eventHandlers.length; ++i) { if (JSEvents.eventHandlers[i].target == eventHandler.target && JSEvents.eventHandlers[i].eventTypeString == eventHandler.eventTypeString) { JSEvents._removeHandler(i--) } } }
    }),
    registerKeyEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.keyEvent) JSEvents.keyEvent = _malloc(164);
        var keyEventHandlerFunc = (function(event) {
            var e = event || window.event;
            var keyEventData = JSEvents.keyEvent;
            stringToUTF8(e.key ? e.key : "", keyEventData + 0, 32);
            stringToUTF8(e.code ? e.code : "", keyEventData + 32, 32);
            HEAP32[keyEventData + 64 >> 2] = e.location;
            HEAP32[keyEventData + 68 >> 2] = e.ctrlKey;
            HEAP32[keyEventData + 72 >> 2] = e.shiftKey;
            HEAP32[keyEventData + 76 >> 2] = e.altKey;
            HEAP32[keyEventData + 80 >> 2] = e.metaKey;
            HEAP32[keyEventData + 84 >> 2] = e.repeat;
            stringToUTF8(e.locale ? e.locale : "", keyEventData + 88, 32);
            stringToUTF8(e.char ? e.char : "", keyEventData + 120, 32);
            HEAP32[keyEventData + 152 >> 2] = e.charCode;
            HEAP32[keyEventData + 156 >> 2] = e.keyCode;
            HEAP32[keyEventData + 160 >> 2] = e.which;
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, keyEventData, userData)) e.preventDefault()
        });
        var eventHandler = { target: JSEvents.findEventTarget(target), allowsDeferredCalls: JSEvents.isInternetExplorer() ? false : true, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: keyEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    getBoundingClientRectOrZeros: (function(target) { return target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0 } }),
    fillMouseEventData: (function(eventStruct, e, target) {
        HEAPF64[eventStruct >> 3] = JSEvents.tick();
        HEAP32[eventStruct + 8 >> 2] = e.screenX;
        HEAP32[eventStruct + 12 >> 2] = e.screenY;
        HEAP32[eventStruct + 16 >> 2] = e.clientX;
        HEAP32[eventStruct + 20 >> 2] = e.clientY;
        HEAP32[eventStruct + 24 >> 2] = e.ctrlKey;
        HEAP32[eventStruct + 28 >> 2] = e.shiftKey;
        HEAP32[eventStruct + 32 >> 2] = e.altKey;
        HEAP32[eventStruct + 36 >> 2] = e.metaKey;
        HEAP16[eventStruct + 40 >> 1] = e.button;
        HEAP16[eventStruct + 42 >> 1] = e.buttons;
        HEAP32[eventStruct + 44 >> 2] = e["movementX"] || e["mozMovementX"] || e["webkitMovementX"] || e.screenX - JSEvents.previousScreenX;
        HEAP32[eventStruct + 48 >> 2] = e["movementY"] || e["mozMovementY"] || e["webkitMovementY"] || e.screenY - JSEvents.previousScreenY;
        if (Module["canvas"]) {
            var rect = Module["canvas"].getBoundingClientRect();
            HEAP32[eventStruct + 60 >> 2] = e.clientX - rect.left;
            HEAP32[eventStruct + 64 >> 2] = e.clientY - rect.top
        } else {
            HEAP32[eventStruct + 60 >> 2] = 0;
            HEAP32[eventStruct + 64 >> 2] = 0
        }
        if (target) {
            var rect = JSEvents.getBoundingClientRectOrZeros(target);
            HEAP32[eventStruct + 52 >> 2] = e.clientX - rect.left;
            HEAP32[eventStruct + 56 >> 2] = e.clientY - rect.top
        } else {
            HEAP32[eventStruct + 52 >> 2] = 0;
            HEAP32[eventStruct + 56 >> 2] = 0
        }
        if (e.type !== "wheel" && e.type !== "mousewheel") {
            JSEvents.previousScreenX = e.screenX;
            JSEvents.previousScreenY = e.screenY
        }
    }),
    registerMouseEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.mouseEvent) JSEvents.mouseEvent = _malloc(72);
        target = JSEvents.findEventTarget(target);
        var mouseEventHandlerFunc = (function(event) {
            var e = event || window.event;
            JSEvents.fillMouseEventData(JSEvents.mouseEvent, e, target);
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, JSEvents.mouseEvent, userData)) e.preventDefault()
        });
        var eventHandler = { target: target, allowsDeferredCalls: eventTypeString != "mousemove" && eventTypeString != "mouseenter" && eventTypeString != "mouseleave", eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: mouseEventHandlerFunc, useCapture: useCapture };
        if (JSEvents.isInternetExplorer() && eventTypeString == "mousedown") eventHandler.allowsDeferredCalls = false;
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    registerWheelEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.wheelEvent) JSEvents.wheelEvent = _malloc(104);
        target = JSEvents.findEventTarget(target);
        var wheelHandlerFunc = (function(event) {
            var e = event || window.event;
            var wheelEvent = JSEvents.wheelEvent;
            JSEvents.fillMouseEventData(wheelEvent, e, target);
            HEAPF64[wheelEvent + 72 >> 3] = e["deltaX"];
            HEAPF64[wheelEvent + 80 >> 3] = e["deltaY"];
            HEAPF64[wheelEvent + 88 >> 3] = e["deltaZ"];
            HEAP32[wheelEvent + 96 >> 2] = e["deltaMode"];
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, wheelEvent, userData)) e.preventDefault()
        });
        var mouseWheelHandlerFunc = (function(event) {
            var e = event || window.event;
            JSEvents.fillMouseEventData(JSEvents.wheelEvent, e, target);
            HEAPF64[JSEvents.wheelEvent + 72 >> 3] = e["wheelDeltaX"] || 0;
            HEAPF64[JSEvents.wheelEvent + 80 >> 3] = -(e["wheelDeltaY"] ? e["wheelDeltaY"] : e["wheelDelta"]);
            HEAPF64[JSEvents.wheelEvent + 88 >> 3] = 0;
            HEAP32[JSEvents.wheelEvent + 96 >> 2] = 0;
            var shouldCancel = Module["dynCall_iiii"](callbackfunc, eventTypeId, JSEvents.wheelEvent, userData);
            if (shouldCancel) { e.preventDefault() }
        });
        var eventHandler = { target: target, allowsDeferredCalls: true, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: eventTypeString == "wheel" ? wheelHandlerFunc : mouseWheelHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    pageScrollPos: (function() { if (window.pageXOffset > 0 || window.pageYOffset > 0) { return [window.pageXOffset, window.pageYOffset] } if (typeof document.documentElement.scrollLeft !== "undefined" || typeof document.documentElement.scrollTop !== "undefined") { return [document.documentElement.scrollLeft, document.documentElement.scrollTop] } return [document.body.scrollLeft | 0, document.body.scrollTop | 0] }),
    registerUiEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.uiEvent) JSEvents.uiEvent = _malloc(36);
        if (eventTypeString == "scroll" && !target) { target = document } else { target = JSEvents.findEventTarget(target) }
        var uiEventHandlerFunc = (function(event) {
            var e = event || window.event;
            if (e.target != target) { return }
            var scrollPos = JSEvents.pageScrollPos();
            var uiEvent = JSEvents.uiEvent;
            HEAP32[uiEvent >> 2] = e.detail;
            HEAP32[uiEvent + 4 >> 2] = document.body.clientWidth;
            HEAP32[uiEvent + 8 >> 2] = document.body.clientHeight;
            HEAP32[uiEvent + 12 >> 2] = window.innerWidth;
            HEAP32[uiEvent + 16 >> 2] = window.innerHeight;
            HEAP32[uiEvent + 20 >> 2] = window.outerWidth;
            HEAP32[uiEvent + 24 >> 2] = window.outerHeight;
            HEAP32[uiEvent + 28 >> 2] = scrollPos[0];
            HEAP32[uiEvent + 32 >> 2] = scrollPos[1];
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, uiEvent, userData)) e.preventDefault()
        });
        var eventHandler = { target: target, allowsDeferredCalls: false, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: uiEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    getNodeNameForTarget: (function(target) { if (!target) return ""; if (target == window) return "#window"; if (target == window.screen) return "#screen"; return target && target.nodeName ? target.nodeName : "" }),
    registerFocusEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.focusEvent) JSEvents.focusEvent = _malloc(256);
        var focusEventHandlerFunc = (function(event) {
            var e = event || window.event;
            var nodeName = JSEvents.getNodeNameForTarget(e.target);
            var id = e.target.id ? e.target.id : "";
            var focusEvent = JSEvents.focusEvent;
            stringToUTF8(nodeName, focusEvent + 0, 128);
            stringToUTF8(id, focusEvent + 128, 128);
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, focusEvent, userData)) e.preventDefault()
        });
        var eventHandler = { target: JSEvents.findEventTarget(target), allowsDeferredCalls: false, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: focusEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    tick: (function() {
        if (window["performance"] && window["performance"]["now"]) return window["performance"]["now"]();
        else return Date.now()
    }),
    fillDeviceOrientationEventData: (function(eventStruct, e, target) {
        HEAPF64[eventStruct >> 3] = JSEvents.tick();
        HEAPF64[eventStruct + 8 >> 3] = e.alpha;
        HEAPF64[eventStruct + 16 >> 3] = e.beta;
        HEAPF64[eventStruct + 24 >> 3] = e.gamma;
        HEAP32[eventStruct + 32 >> 2] = e.absolute
    }),
    registerDeviceOrientationEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.deviceOrientationEvent) JSEvents.deviceOrientationEvent = _malloc(40);
        var deviceOrientationEventHandlerFunc = (function(event) {
            var e = event || window.event;
            JSEvents.fillDeviceOrientationEventData(JSEvents.deviceOrientationEvent, e, target);
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, JSEvents.deviceOrientationEvent, userData)) e.preventDefault()
        });
        var eventHandler = { target: JSEvents.findEventTarget(target), allowsDeferredCalls: false, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: deviceOrientationEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    fillDeviceMotionEventData: (function(eventStruct, e, target) {
        HEAPF64[eventStruct >> 3] = JSEvents.tick();
        HEAPF64[eventStruct + 8 >> 3] = e.acceleration.x;
        HEAPF64[eventStruct + 16 >> 3] = e.acceleration.y;
        HEAPF64[eventStruct + 24 >> 3] = e.acceleration.z;
        HEAPF64[eventStruct + 32 >> 3] = e.accelerationIncludingGravity.x;
        HEAPF64[eventStruct + 40 >> 3] = e.accelerationIncludingGravity.y;
        HEAPF64[eventStruct + 48 >> 3] = e.accelerationIncludingGravity.z;
        HEAPF64[eventStruct + 56 >> 3] = e.rotationRate.alpha;
        HEAPF64[eventStruct + 64 >> 3] = e.rotationRate.beta;
        HEAPF64[eventStruct + 72 >> 3] = e.rotationRate.gamma
    }),
    registerDeviceMotionEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.deviceMotionEvent) JSEvents.deviceMotionEvent = _malloc(80);
        var deviceMotionEventHandlerFunc = (function(event) {
            var e = event || window.event;
            JSEvents.fillDeviceMotionEventData(JSEvents.deviceMotionEvent, e, target);
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, JSEvents.deviceMotionEvent, userData)) e.preventDefault()
        });
        var eventHandler = { target: JSEvents.findEventTarget(target), allowsDeferredCalls: false, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: deviceMotionEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    screenOrientation: (function() { if (!window.screen) return undefined; return window.screen.orientation || window.screen.mozOrientation || window.screen.webkitOrientation || window.screen.msOrientation }),
    fillOrientationChangeEventData: (function(eventStruct, e) {
        var orientations = ["portrait-primary", "portrait-secondary", "landscape-primary", "landscape-secondary"];
        var orientations2 = ["portrait", "portrait", "landscape", "landscape"];
        var orientationString = JSEvents.screenOrientation();
        var orientation = orientations.indexOf(orientationString);
        if (orientation == -1) { orientation = orientations2.indexOf(orientationString) }
        HEAP32[eventStruct >> 2] = 1 << orientation;
        HEAP32[eventStruct + 4 >> 2] = window.orientation
    }),
    registerOrientationChangeEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.orientationChangeEvent) JSEvents.orientationChangeEvent = _malloc(8);
        if (!target) { target = window.screen } else { target = JSEvents.findEventTarget(target) }
        var orientationChangeEventHandlerFunc = (function(event) {
            var e = event || window.event;
            var orientationChangeEvent = JSEvents.orientationChangeEvent;
            JSEvents.fillOrientationChangeEventData(orientationChangeEvent, e);
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, orientationChangeEvent, userData)) e.preventDefault()
        });
        if (eventTypeString == "orientationchange" && window.screen.mozOrientation !== undefined) { eventTypeString = "mozorientationchange" }
        var eventHandler = { target: target, allowsDeferredCalls: false, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: orientationChangeEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    fullscreenEnabled: (function() { return document.fullscreenEnabled || document.mozFullScreenEnabled || document.webkitFullscreenEnabled || document.msFullscreenEnabled }),
    fillFullscreenChangeEventData: (function(eventStruct, e) {
        var fullscreenElement = document.fullscreenElement || document.mozFullScreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
        var isFullscreen = !!fullscreenElement;
        HEAP32[eventStruct >> 2] = isFullscreen;
        HEAP32[eventStruct + 4 >> 2] = JSEvents.fullscreenEnabled();
        var reportedElement = isFullscreen ? fullscreenElement : JSEvents.previousFullscreenElement;
        var nodeName = JSEvents.getNodeNameForTarget(reportedElement);
        var id = reportedElement && reportedElement.id ? reportedElement.id : "";
        stringToUTF8(nodeName, eventStruct + 8, 128);
        stringToUTF8(id, eventStruct + 136, 128);
        HEAP32[eventStruct + 264 >> 2] = reportedElement ? reportedElement.clientWidth : 0;
        HEAP32[eventStruct + 268 >> 2] = reportedElement ? reportedElement.clientHeight : 0;
        HEAP32[eventStruct + 272 >> 2] = screen.width;
        HEAP32[eventStruct + 276 >> 2] = screen.height;
        if (isFullscreen) { JSEvents.previousFullscreenElement = fullscreenElement }
    }),
    registerFullscreenChangeEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.fullscreenChangeEvent) JSEvents.fullscreenChangeEvent = _malloc(280);
        if (!target) target = document;
        else target = JSEvents.findEventTarget(target);
        var fullscreenChangeEventhandlerFunc = (function(event) {
            var e = event || window.event;
            var fullscreenChangeEvent = JSEvents.fullscreenChangeEvent;
            JSEvents.fillFullscreenChangeEventData(fullscreenChangeEvent, e);
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, fullscreenChangeEvent, userData)) e.preventDefault()
        });
        var eventHandler = { target: target, allowsDeferredCalls: false, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: fullscreenChangeEventhandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    resizeCanvasForFullscreen: (function(target, strategy) {
        var restoreOldStyle = __registerRestoreOldStyle(target);
        var cssWidth = strategy.softFullscreen ? window.innerWidth : screen.width;
        var cssHeight = strategy.softFullscreen ? window.innerHeight : screen.height;
        var rect = target.getBoundingClientRect();
        var windowedCssWidth = rect.right - rect.left;
        var windowedCssHeight = rect.bottom - rect.top;
        var canvasSize = __get_canvas_element_size(target);
        var windowedRttWidth = canvasSize[0];
        var windowedRttHeight = canvasSize[1];
        if (strategy.scaleMode == 3) {
            __setLetterbox(target, (cssHeight - windowedCssHeight) / 2, (cssWidth - windowedCssWidth) / 2);
            cssWidth = windowedCssWidth;
            cssHeight = windowedCssHeight
        } else if (strategy.scaleMode == 2) {
            if (cssWidth * windowedRttHeight < windowedRttWidth * cssHeight) {
                var desiredCssHeight = windowedRttHeight * cssWidth / windowedRttWidth;
                __setLetterbox(target, (cssHeight - desiredCssHeight) / 2, 0);
                cssHeight = desiredCssHeight
            } else {
                var desiredCssWidth = windowedRttWidth * cssHeight / windowedRttHeight;
                __setLetterbox(target, 0, (cssWidth - desiredCssWidth) / 2);
                cssWidth = desiredCssWidth
            }
        }
        if (!target.style.backgroundColor) target.style.backgroundColor = "black";
        if (!document.body.style.backgroundColor) document.body.style.backgroundColor = "black";
        target.style.width = cssWidth + "px";
        target.style.height = cssHeight + "px";
        if (strategy.filteringMode == 1) {
            target.style.imageRendering = "optimizeSpeed";
            target.style.imageRendering = "-moz-crisp-edges";
            target.style.imageRendering = "-o-crisp-edges";
            target.style.imageRendering = "-webkit-optimize-contrast";
            target.style.imageRendering = "optimize-contrast";
            target.style.imageRendering = "crisp-edges";
            target.style.imageRendering = "pixelated"
        }
        var dpiScale = strategy.canvasResolutionScaleMode == 2 ? window.devicePixelRatio : 1;
        if (strategy.canvasResolutionScaleMode != 0) {
            var newWidth = cssWidth * dpiScale | 0;
            var newHeight = cssHeight * dpiScale | 0;
            __set_canvas_element_size(target, newWidth, newHeight);
            if (target.GLctxObject) target.GLctxObject.GLctx.viewport(0, 0, newWidth, newHeight)
        }
        return restoreOldStyle
    }),
    requestFullscreen: (function(target, strategy) { if (strategy.scaleMode != 0 || strategy.canvasResolutionScaleMode != 0) { JSEvents.resizeCanvasForFullscreen(target, strategy) } if (target.requestFullscreen) { target.requestFullscreen() } else if (target.msRequestFullscreen) { target.msRequestFullscreen() } else if (target.mozRequestFullScreen) { target.mozRequestFullScreen() } else if (target.mozRequestFullscreen) { target.mozRequestFullscreen() } else if (target.webkitRequestFullscreen) { target.webkitRequestFullscreen(Element.ALLOW_KEYBOARD_INPUT) } else { if (typeof JSEvents.fullscreenEnabled() === "undefined") { return -1 } else { return -3 } } if (strategy.canvasResizedCallback) { Module["dynCall_iiii"](strategy.canvasResizedCallback, 37, 0, strategy.canvasResizedCallbackUserData) } return 0 }),
    fillPointerlockChangeEventData: (function(eventStruct, e) {
        var pointerLockElement = document.pointerLockElement || document.mozPointerLockElement || document.webkitPointerLockElement || document.msPointerLockElement;
        var isPointerlocked = !!pointerLockElement;
        HEAP32[eventStruct >> 2] = isPointerlocked;
        var nodeName = JSEvents.getNodeNameForTarget(pointerLockElement);
        var id = pointerLockElement && pointerLockElement.id ? pointerLockElement.id : "";
        stringToUTF8(nodeName, eventStruct + 4, 128);
        stringToUTF8(id, eventStruct + 132, 128)
    }),
    registerPointerlockChangeEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.pointerlockChangeEvent) JSEvents.pointerlockChangeEvent = _malloc(260);
        if (!target) target = document;
        else target = JSEvents.findEventTarget(target);
        var pointerlockChangeEventHandlerFunc = (function(event) {
            var e = event || window.event;
            var pointerlockChangeEvent = JSEvents.pointerlockChangeEvent;
            JSEvents.fillPointerlockChangeEventData(pointerlockChangeEvent, e);
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, pointerlockChangeEvent, userData)) e.preventDefault()
        });
        var eventHandler = { target: target, allowsDeferredCalls: false, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: pointerlockChangeEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    registerPointerlockErrorEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString) {
        if (!target) target = document;
        else target = JSEvents.findEventTarget(target);
        var pointerlockErrorEventHandlerFunc = (function(event) { var e = event || window.event; if (Module["dynCall_iiii"](callbackfunc, eventTypeId, 0, userData)) e.preventDefault() });
        var eventHandler = { target: target, allowsDeferredCalls: false, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: pointerlockErrorEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    requestPointerLock: (function(target) { if (target.requestPointerLock) { target.requestPointerLock() } else if (target.mozRequestPointerLock) { target.mozRequestPointerLock() } else if (target.webkitRequestPointerLock) { target.webkitRequestPointerLock() } else if (target.msRequestPointerLock) { target.msRequestPointerLock() } else { if (document.body.requestPointerLock || document.body.mozRequestPointerLock || document.body.webkitRequestPointerLock || document.body.msRequestPointerLock) { return -3 } else { return -1 } } return 0 }),
    fillVisibilityChangeEventData: (function(eventStruct, e) {
        var visibilityStates = ["hidden", "visible", "prerender", "unloaded"];
        var visibilityState = visibilityStates.indexOf(document.visibilityState);
        HEAP32[eventStruct >> 2] = document.hidden;
        HEAP32[eventStruct + 4 >> 2] = visibilityState
    }),
    registerVisibilityChangeEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.visibilityChangeEvent) JSEvents.visibilityChangeEvent = _malloc(8);
        if (!target) target = document;
        else target = JSEvents.findEventTarget(target);
        var visibilityChangeEventHandlerFunc = (function(event) {
            var e = event || window.event;
            var visibilityChangeEvent = JSEvents.visibilityChangeEvent;
            JSEvents.fillVisibilityChangeEventData(visibilityChangeEvent, e);
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, visibilityChangeEvent, userData)) e.preventDefault()
        });
        var eventHandler = { target: target, allowsDeferredCalls: false, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: visibilityChangeEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    registerTouchEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.touchEvent) JSEvents.touchEvent = _malloc(1684);
        target = JSEvents.findEventTarget(target);
        var touchEventHandlerFunc = (function(event) {
            var e = event || window.event;
            var touches = {};
            for (var i = 0; i < e.touches.length; ++i) {
                var touch = e.touches[i];
                touches[touch.identifier] = touch
            }
            for (var i = 0; i < e.changedTouches.length; ++i) {
                var touch = e.changedTouches[i];
                touches[touch.identifier] = touch;
                touch.changed = true
            }
            for (var i = 0; i < e.targetTouches.length; ++i) {
                var touch = e.targetTouches[i];
                touches[touch.identifier].onTarget = true
            }
            var touchEvent = JSEvents.touchEvent;
            var ptr = touchEvent;
            HEAP32[ptr + 4 >> 2] = e.ctrlKey;
            HEAP32[ptr + 8 >> 2] = e.shiftKey;
            HEAP32[ptr + 12 >> 2] = e.altKey;
            HEAP32[ptr + 16 >> 2] = e.metaKey;
            ptr += 20;
            var canvasRect = Module["canvas"] ? Module["canvas"].getBoundingClientRect() : undefined;
            var targetRect = JSEvents.getBoundingClientRectOrZeros(target);
            var numTouches = 0;
            for (var i in touches) {
                var t = touches[i];
                HEAP32[ptr >> 2] = t.identifier;
                HEAP32[ptr + 4 >> 2] = t.screenX;
                HEAP32[ptr + 8 >> 2] = t.screenY;
                HEAP32[ptr + 12 >> 2] = t.clientX;
                HEAP32[ptr + 16 >> 2] = t.clientY;
                HEAP32[ptr + 20 >> 2] = t.pageX;
                HEAP32[ptr + 24 >> 2] = t.pageY;
                HEAP32[ptr + 28 >> 2] = t.changed;
                HEAP32[ptr + 32 >> 2] = t.onTarget;
                if (canvasRect) {
                    HEAP32[ptr + 44 >> 2] = t.clientX - canvasRect.left;
                    HEAP32[ptr + 48 >> 2] = t.clientY - canvasRect.top
                } else {
                    HEAP32[ptr + 44 >> 2] = 0;
                    HEAP32[ptr + 48 >> 2] = 0
                }
                HEAP32[ptr + 36 >> 2] = t.clientX - targetRect.left;
                HEAP32[ptr + 40 >> 2] = t.clientY - targetRect.top;
                ptr += 52;
                if (++numTouches >= 32) { break }
            }
            HEAP32[touchEvent >> 2] = numTouches;
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, touchEvent, userData)) e.preventDefault()
        });
        var eventHandler = { target: target, allowsDeferredCalls: eventTypeString == "touchstart" || eventTypeString == "touchend", eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: touchEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    fillGamepadEventData: (function(eventStruct, e) {
        HEAPF64[eventStruct >> 3] = e.timestamp;
        for (var i = 0; i < e.axes.length; ++i) { HEAPF64[eventStruct + i * 8 + 16 >> 3] = e.axes[i] }
        for (var i = 0; i < e.buttons.length; ++i) { if (typeof e.buttons[i] === "object") { HEAPF64[eventStruct + i * 8 + 528 >> 3] = e.buttons[i].value } else { HEAPF64[eventStruct + i * 8 + 528 >> 3] = e.buttons[i] } }
        for (var i = 0; i < e.buttons.length; ++i) { if (typeof e.buttons[i] === "object") { HEAP32[eventStruct + i * 4 + 1040 >> 2] = e.buttons[i].pressed } else { HEAP32[eventStruct + i * 4 + 1040 >> 2] = e.buttons[i] == 1 } }
        HEAP32[eventStruct + 1296 >> 2] = e.connected;
        HEAP32[eventStruct + 1300 >> 2] = e.index;
        HEAP32[eventStruct + 8 >> 2] = e.axes.length;
        HEAP32[eventStruct + 12 >> 2] = e.buttons.length;
        stringToUTF8(e.id, eventStruct + 1304, 64);
        stringToUTF8(e.mapping, eventStruct + 1368, 64)
    }),
    registerGamepadEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.gamepadEvent) JSEvents.gamepadEvent = _malloc(1432);
        var gamepadEventHandlerFunc = (function(event) {
            var e = event || window.event;
            var gamepadEvent = JSEvents.gamepadEvent;
            JSEvents.fillGamepadEventData(gamepadEvent, e.gamepad);
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, gamepadEvent, userData)) e.preventDefault()
        });
        var eventHandler = { target: JSEvents.findEventTarget(target), allowsDeferredCalls: true, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: gamepadEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    registerBeforeUnloadEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString) {
        var beforeUnloadEventHandlerFunc = (function(event) {
            var e = event || window.event;
            var confirmationMessage = Module["dynCall_iiii"](callbackfunc, eventTypeId, 0, userData);
            if (confirmationMessage) { confirmationMessage = Pointer_stringify(confirmationMessage) }
            if (confirmationMessage) {
                e.preventDefault();
                e.returnValue = confirmationMessage;
                return confirmationMessage
            }
        });
        var eventHandler = { target: JSEvents.findEventTarget(target), allowsDeferredCalls: false, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: beforeUnloadEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    battery: (function() { return navigator.battery || navigator.mozBattery || navigator.webkitBattery }),
    fillBatteryEventData: (function(eventStruct, e) {
        HEAPF64[eventStruct >> 3] = e.chargingTime;
        HEAPF64[eventStruct + 8 >> 3] = e.dischargingTime;
        HEAPF64[eventStruct + 16 >> 3] = e.level;
        HEAP32[eventStruct + 24 >> 2] = e.charging
    }),
    registerBatteryEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!JSEvents.batteryEvent) JSEvents.batteryEvent = _malloc(32);
        var batteryEventHandlerFunc = (function(event) {
            var e = event || window.event;
            var batteryEvent = JSEvents.batteryEvent;
            JSEvents.fillBatteryEventData(batteryEvent, JSEvents.battery());
            if (Module["dynCall_iiii"](callbackfunc, eventTypeId, batteryEvent, userData)) e.preventDefault()
        });
        var eventHandler = { target: JSEvents.findEventTarget(target), allowsDeferredCalls: false, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: batteryEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    }),
    registerWebGlEventCallback: (function(target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) {
        if (!target) target = Module["canvas"];
        var webGlEventHandlerFunc = (function(event) { var e = event || window.event; if (Module["dynCall_iiii"](callbackfunc, eventTypeId, 0, userData)) e.preventDefault() });
        var eventHandler = { target: JSEvents.findEventTarget(target), allowsDeferredCalls: false, eventTypeString: eventTypeString, callbackfunc: callbackfunc, handlerFunc: webGlEventHandlerFunc, useCapture: useCapture };
        JSEvents.registerOrRemoveHandler(eventHandler)
    })
};
var __currentFullscreenStrategy = {};

function _emscripten_exit_fullscreen() {
    if (typeof JSEvents.fullscreenEnabled() === "undefined") return -1;
    JSEvents.removeDeferredCalls(JSEvents.requestFullscreen);
    if (document.exitFullscreen) { document.exitFullscreen() } else if (document.msExitFullscreen) { document.msExitFullscreen() } else if (document.mozCancelFullScreen) { document.mozCancelFullScreen() } else if (document.webkitExitFullscreen) { document.webkitExitFullscreen() } else { return -1 }
    if (__currentFullscreenStrategy.canvasResizedCallback) { Module["dynCall_iiii"](__currentFullscreenStrategy.canvasResizedCallback, 37, 0, __currentFullscreenStrategy.canvasResizedCallbackUserData) }
    return 0
}

function _emscripten_exit_pointerlock() { JSEvents.removeDeferredCalls(JSEvents.requestPointerLock); if (document.exitPointerLock) { document.exitPointerLock() } else if (document.msExitPointerLock) { document.msExitPointerLock() } else if (document.mozExitPointerLock) { document.mozExitPointerLock() } else if (document.webkitExitPointerLock) { document.webkitExitPointerLock() } else { return -1 } return 0 }

function _emscripten_get_device_pixel_ratio() { return window.devicePixelRatio || 1 }

function _emscripten_get_element_css_size(target, width, height) {
    if (target) target = JSEvents.findEventTarget(target);
    else target = Module["canvas"];
    if (!target) return -4;
    if (target.getBoundingClientRect) {
        var rect = target.getBoundingClientRect();
        HEAPF64[width >> 3] = rect.right - rect.left;
        HEAPF64[height >> 3] = rect.bottom - rect.top
    } else {
        HEAPF64[width >> 3] = target.clientWidth;
        HEAPF64[height >> 3] = target.clientHeight
    }
    return 0
}

function __emscripten_sample_gamepad_data() {
    if (!JSEvents.numGamepadsConnected) return;
    if (Browser.mainLoop.currentFrameNumber !== JSEvents.lastGamepadStateFrame || !Browser.mainLoop.currentFrameNumber) {
        JSEvents.lastGamepadState = navigator.getGamepads ? navigator.getGamepads() : navigator.webkitGetGamepads ? navigator.webkitGetGamepads : null;
        JSEvents.lastGamepadStateFrame = Browser.mainLoop.currentFrameNumber
    }
}

function _emscripten_get_gamepad_status(index, gamepadState) {
    __emscripten_sample_gamepad_data();
    if (!JSEvents.lastGamepadState) return -1;
    if (index < 0 || index >= JSEvents.lastGamepadState.length) return -5;
    if (!JSEvents.lastGamepadState[index]) return -7;
    JSEvents.fillGamepadEventData(gamepadState, JSEvents.lastGamepadState[index]);
    return 0
}

function _emscripten_get_num_gamepads() {
    if (!JSEvents.numGamepadsConnected) return 0;
    __emscripten_sample_gamepad_data();
    if (!JSEvents.lastGamepadState) return -1;
    return JSEvents.lastGamepadState.length
}

function _emscripten_glAccum() {
    err("missing function: emscripten_glAccum");
    abort(-1)
}

function _emscripten_glActiveTexture(x0) { GLctx["activeTexture"](x0) }

function _emscripten_glAlphaFunc() {
    err("missing function: emscripten_glAlphaFunc");
    abort(-1)
}

function _emscripten_glAreTexturesResident() {
    err("missing function: emscripten_glAreTexturesResident");
    abort(-1)
}

function _emscripten_glArrayElement() {
    err("missing function: emscripten_glArrayElement");
    abort(-1)
}

function _emscripten_glAttachObjectARB() {
    err("missing function: emscripten_glAttachObjectARB");
    abort(-1)
}

function _emscripten_glAttachShader(program, shader) { GLctx.attachShader(GL.programs[program], GL.shaders[shader]) }

function _emscripten_glBegin() { throw "Legacy GL function (glBegin) called. If you want legacy GL emulation, you need to compile with -s LEGACY_GL_EMULATION=1 to enable legacy GL emulation." }

function _emscripten_glBeginConditionalRender() {
    err("missing function: emscripten_glBeginConditionalRender");
    abort(-1)
}

function _emscripten_glBeginQuery() {
    err("missing function: emscripten_glBeginQuery");
    abort(-1)
}

function _emscripten_glBeginTransformFeedback() {
    err("missing function: emscripten_glBeginTransformFeedback");
    abort(-1)
}

function _emscripten_glBindAttribLocation(program, index, name) {
    name = Pointer_stringify(name);
    GLctx.bindAttribLocation(GL.programs[program], index, name)
}

function _emscripten_glBindBuffer(target, buffer) {
    var bufferObj = buffer ? GL.buffers[buffer] : null;
    GLctx.bindBuffer(target, bufferObj)
}

function _emscripten_glBindBufferBase() {
    err("missing function: emscripten_glBindBufferBase");
    abort(-1)
}

function _emscripten_glBindBufferRange() {
    err("missing function: emscripten_glBindBufferRange");
    abort(-1)
}

function _emscripten_glBindFragDataLocation() {
    err("missing function: emscripten_glBindFragDataLocation");
    abort(-1)
}

function _emscripten_glBindFramebuffer(target, framebuffer) { GLctx.bindFramebuffer(target, framebuffer ? GL.framebuffers[framebuffer] : null) }

function _emscripten_glBindProgramARB() {
    err("missing function: emscripten_glBindProgramARB");
    abort(-1)
}

function _emscripten_glBindRenderbuffer(target, renderbuffer) { GLctx.bindRenderbuffer(target, renderbuffer ? GL.renderbuffers[renderbuffer] : null) }

function _emscripten_glBindTexture(target, texture) { GLctx.bindTexture(target, texture ? GL.textures[texture] : null) }

function _emscripten_glBindVertexArray(vao) { GLctx["bindVertexArray"](GL.vaos[vao]) }

function _emscripten_glBitmap() {
    err("missing function: emscripten_glBitmap");
    abort(-1)
}

function _emscripten_glBlendColor(x0, x1, x2, x3) { GLctx["blendColor"](x0, x1, x2, x3) }

function _emscripten_glBlendEquation(x0) { GLctx["blendEquation"](x0) }

function _emscripten_glBlendEquationSeparate(x0, x1) { GLctx["blendEquationSeparate"](x0, x1) }

function _emscripten_glBlendFunc(x0, x1) { GLctx["blendFunc"](x0, x1) }

function _emscripten_glBlendFuncSeparate(x0, x1, x2, x3) { GLctx["blendFuncSeparate"](x0, x1, x2, x3) }

function _emscripten_glBlitFramebuffer() {
    err("missing function: emscripten_glBlitFramebuffer");
    abort(-1)
}

function _emscripten_glBufferData(target, size, data, usage) { if (!data) { GLctx.bufferData(target, size, usage) } else { GLctx.bufferData(target, HEAPU8.subarray(data, data + size), usage) } }

function _emscripten_glBufferSubData(target, offset, size, data) { GLctx.bufferSubData(target, offset, HEAPU8.subarray(data, data + size)) }

function _emscripten_glCallList() {
    err("missing function: emscripten_glCallList");
    abort(-1)
}

function _emscripten_glCallLists() {
    err("missing function: emscripten_glCallLists");
    abort(-1)
}

function _emscripten_glCheckFramebufferStatus(x0) { return GLctx["checkFramebufferStatus"](x0) }

function _emscripten_glClampColor() {
    err("missing function: emscripten_glClampColor");
    abort(-1)
}

function _emscripten_glClear(x0) { GLctx["clear"](x0) }

function _emscripten_glClearAccum() {
    err("missing function: emscripten_glClearAccum");
    abort(-1)
}

function _emscripten_glClearBufferfi() {
    err("missing function: emscripten_glClearBufferfi");
    abort(-1)
}

function _emscripten_glClearBufferfv() {
    err("missing function: emscripten_glClearBufferfv");
    abort(-1)
}

function _emscripten_glClearBufferiv() {
    err("missing function: emscripten_glClearBufferiv");
    abort(-1)
}

function _emscripten_glClearBufferuiv() {
    err("missing function: emscripten_glClearBufferuiv");
    abort(-1)
}

function _emscripten_glClearColor(x0, x1, x2, x3) { GLctx["clearColor"](x0, x1, x2, x3) }

function _emscripten_glClearDepth(x0) { GLctx["clearDepth"](x0) }

function _emscripten_glClearDepthf(x0) { GLctx["clearDepth"](x0) }

function _emscripten_glClearIndex() {
    err("missing function: emscripten_glClearIndex");
    abort(-1)
}

function _emscripten_glClearStencil(x0) { GLctx["clearStencil"](x0) }

function _emscripten_glClientActiveTexture() {
    err("missing function: emscripten_glClientActiveTexture");
    abort(-1)
}

function _emscripten_glClipPlane() {
    err("missing function: emscripten_glClipPlane");
    abort(-1)
}

function _emscripten_glColor3b() {
    err("missing function: emscripten_glColor3b");
    abort(-1)
}

function _emscripten_glColor3bv() {
    err("missing function: emscripten_glColor3bv");
    abort(-1)
}

function _emscripten_glColor3d() {
    err("missing function: emscripten_glColor3d");
    abort(-1)
}

function _emscripten_glColor3dv() {
    err("missing function: emscripten_glColor3dv");
    abort(-1)
}

function _emscripten_glColor3f() {
    err("missing function: emscripten_glColor3f");
    abort(-1)
}

function _emscripten_glColor3fv() {
    err("missing function: emscripten_glColor3fv");
    abort(-1)
}

function _emscripten_glColor3i() {
    err("missing function: emscripten_glColor3i");
    abort(-1)
}

function _emscripten_glColor3iv() {
    err("missing function: emscripten_glColor3iv");
    abort(-1)
}

function _emscripten_glColor3s() {
    err("missing function: emscripten_glColor3s");
    abort(-1)
}

function _emscripten_glColor3sv() {
    err("missing function: emscripten_glColor3sv");
    abort(-1)
}

function _emscripten_glColor3ub() {
    err("missing function: emscripten_glColor3ub");
    abort(-1)
}

function _emscripten_glColor3ubv() {
    err("missing function: emscripten_glColor3ubv");
    abort(-1)
}

function _emscripten_glColor3ui() {
    err("missing function: emscripten_glColor3ui");
    abort(-1)
}

function _emscripten_glColor3uiv() {
    err("missing function: emscripten_glColor3uiv");
    abort(-1)
}

function _emscripten_glColor3us() {
    err("missing function: emscripten_glColor3us");
    abort(-1)
}

function _emscripten_glColor3usv() {
    err("missing function: emscripten_glColor3usv");
    abort(-1)
}

function _emscripten_glColor4b() {
    err("missing function: emscripten_glColor4b");
    abort(-1)
}

function _emscripten_glColor4bv() {
    err("missing function: emscripten_glColor4bv");
    abort(-1)
}

function _emscripten_glColor4d() {
    err("missing function: emscripten_glColor4d");
    abort(-1)
}

function _emscripten_glColor4dv() {
    err("missing function: emscripten_glColor4dv");
    abort(-1)
}

function _emscripten_glColor4f() {
    err("missing function: emscripten_glColor4f");
    abort(-1)
}

function _emscripten_glColor4fv() {
    err("missing function: emscripten_glColor4fv");
    abort(-1)
}

function _emscripten_glColor4i() {
    err("missing function: emscripten_glColor4i");
    abort(-1)
}

function _emscripten_glColor4iv() {
    err("missing function: emscripten_glColor4iv");
    abort(-1)
}

function _emscripten_glColor4s() {
    err("missing function: emscripten_glColor4s");
    abort(-1)
}

function _emscripten_glColor4sv() {
    err("missing function: emscripten_glColor4sv");
    abort(-1)
}

function _emscripten_glColor4ub() {
    err("missing function: emscripten_glColor4ub");
    abort(-1)
}

function _emscripten_glColor4ubv() {
    err("missing function: emscripten_glColor4ubv");
    abort(-1)
}

function _emscripten_glColor4ui() {
    err("missing function: emscripten_glColor4ui");
    abort(-1)
}

function _emscripten_glColor4uiv() {
    err("missing function: emscripten_glColor4uiv");
    abort(-1)
}

function _emscripten_glColor4us() {
    err("missing function: emscripten_glColor4us");
    abort(-1)
}

function _emscripten_glColor4usv() {
    err("missing function: emscripten_glColor4usv");
    abort(-1)
}

function _emscripten_glColorMask(red, green, blue, alpha) { GLctx.colorMask(!!red, !!green, !!blue, !!alpha) }

function _emscripten_glColorMaski() {
    err("missing function: emscripten_glColorMaski");
    abort(-1)
}

function _emscripten_glColorMaterial() {
    err("missing function: emscripten_glColorMaterial");
    abort(-1)
}

function _emscripten_glColorPointer() {
    err("missing function: emscripten_glColorPointer");
    abort(-1)
}

function _emscripten_glColorSubTable() {
    err("missing function: emscripten_glColorSubTable");
    abort(-1)
}

function _emscripten_glColorTable() {
    err("missing function: emscripten_glColorTable");
    abort(-1)
}

function _emscripten_glColorTableParameterfv() {
    err("missing function: emscripten_glColorTableParameterfv");
    abort(-1)
}

function _emscripten_glColorTableParameteriv() {
    err("missing function: emscripten_glColorTableParameteriv");
    abort(-1)
}

function _emscripten_glCompileShader(shader) { GLctx.compileShader(GL.shaders[shader]) }

function _emscripten_glCompressedTexImage1D() {
    err("missing function: emscripten_glCompressedTexImage1D");
    abort(-1)
}

function _emscripten_glCompressedTexImage2D(target, level, internalFormat, width, height, border, imageSize, data) { GLctx["compressedTexImage2D"](target, level, internalFormat, width, height, border, data ? HEAPU8.subarray(data, data + imageSize) : null) }

function _emscripten_glCompressedTexImage3D() {
    err("missing function: emscripten_glCompressedTexImage3D");
    abort(-1)
}

function _emscripten_glCompressedTexSubImage1D() {
    err("missing function: emscripten_glCompressedTexSubImage1D");
    abort(-1)
}

function _emscripten_glCompressedTexSubImage2D(target, level, xoffset, yoffset, width, height, format, imageSize, data) { GLctx["compressedTexSubImage2D"](target, level, xoffset, yoffset, width, height, format, data ? HEAPU8.subarray(data, data + imageSize) : null) }

function _emscripten_glCompressedTexSubImage3D() {
    err("missing function: emscripten_glCompressedTexSubImage3D");
    abort(-1)
}

function _emscripten_glConvolutionFilter1D() {
    err("missing function: emscripten_glConvolutionFilter1D");
    abort(-1)
}

function _emscripten_glConvolutionFilter2D() {
    err("missing function: emscripten_glConvolutionFilter2D");
    abort(-1)
}

function _emscripten_glConvolutionParameterf() {
    err("missing function: emscripten_glConvolutionParameterf");
    abort(-1)
}

function _emscripten_glConvolutionParameterfv() {
    err("missing function: emscripten_glConvolutionParameterfv");
    abort(-1)
}

function _emscripten_glConvolutionParameteri() {
    err("missing function: emscripten_glConvolutionParameteri");
    abort(-1)
}

function _emscripten_glConvolutionParameteriv() {
    err("missing function: emscripten_glConvolutionParameteriv");
    abort(-1)
}

function _emscripten_glCopyColorSubTable() {
    err("missing function: emscripten_glCopyColorSubTable");
    abort(-1)
}

function _emscripten_glCopyColorTable() {
    err("missing function: emscripten_glCopyColorTable");
    abort(-1)
}

function _emscripten_glCopyConvolutionFilter1D() {
    err("missing function: emscripten_glCopyConvolutionFilter1D");
    abort(-1)
}

function _emscripten_glCopyConvolutionFilter2D() {
    err("missing function: emscripten_glCopyConvolutionFilter2D");
    abort(-1)
}

function _emscripten_glCopyPixels() {
    err("missing function: emscripten_glCopyPixels");
    abort(-1)
}

function _emscripten_glCopyTexImage1D() {
    err("missing function: emscripten_glCopyTexImage1D");
    abort(-1)
}

function _emscripten_glCopyTexImage2D(x0, x1, x2, x3, x4, x5, x6, x7) { GLctx["copyTexImage2D"](x0, x1, x2, x3, x4, x5, x6, x7) }

function _emscripten_glCopyTexSubImage1D() {
    err("missing function: emscripten_glCopyTexSubImage1D");
    abort(-1)
}

function _emscripten_glCopyTexSubImage2D(x0, x1, x2, x3, x4, x5, x6, x7) { GLctx["copyTexSubImage2D"](x0, x1, x2, x3, x4, x5, x6, x7) }

function _emscripten_glCopyTexSubImage3D() {
    err("missing function: emscripten_glCopyTexSubImage3D");
    abort(-1)
}

function _emscripten_glCreateProgram() {
    var id = GL.getNewId(GL.programs);
    var program = GLctx.createProgram();
    program.name = id;
    GL.programs[id] = program;
    return id
}

function _emscripten_glCreateProgramObjectARB() {
    err("missing function: emscripten_glCreateProgramObjectARB");
    abort(-1)
}

function _emscripten_glCreateShader(shaderType) {
    var id = GL.getNewId(GL.shaders);
    GL.shaders[id] = GLctx.createShader(shaderType);
    return id
}

function _emscripten_glCreateShaderObjectARB() {
    err("missing function: emscripten_glCreateShaderObjectARB");
    abort(-1)
}

function _emscripten_glCullFace(x0) { GLctx["cullFace"](x0) }

function _emscripten_glDeleteBuffers(n, buffers) {
    for (var i = 0; i < n; i++) {
        var id = HEAP32[buffers + i * 4 >> 2];
        var buffer = GL.buffers[id];
        if (!buffer) continue;
        GLctx.deleteBuffer(buffer);
        buffer.name = 0;
        GL.buffers[id] = null;
        if (id == GL.currArrayBuffer) GL.currArrayBuffer = 0;
        if (id == GL.currElementArrayBuffer) GL.currElementArrayBuffer = 0
    }
}

function _emscripten_glDeleteFramebuffers(n, framebuffers) {
    for (var i = 0; i < n; ++i) {
        var id = HEAP32[framebuffers + i * 4 >> 2];
        var framebuffer = GL.framebuffers[id];
        if (!framebuffer) continue;
        GLctx.deleteFramebuffer(framebuffer);
        framebuffer.name = 0;
        GL.framebuffers[id] = null
    }
}

function _emscripten_glDeleteLists() {
    err("missing function: emscripten_glDeleteLists");
    abort(-1)
}

function _emscripten_glDeleteObjectARB() {
    err("missing function: emscripten_glDeleteObjectARB");
    abort(-1)
}

function _emscripten_glDeleteProgram(id) {
    if (!id) return;
    var program = GL.programs[id];
    if (!program) { GL.recordError(1281); return }
    GLctx.deleteProgram(program);
    program.name = 0;
    GL.programs[id] = null;
    GL.programInfos[id] = null
}

function _emscripten_glDeleteProgramsARB() {
    err("missing function: emscripten_glDeleteProgramsARB");
    abort(-1)
}

function _emscripten_glDeleteQueries() {
    err("missing function: emscripten_glDeleteQueries");
    abort(-1)
}

function _emscripten_glDeleteRenderbuffers(n, renderbuffers) {
    for (var i = 0; i < n; i++) {
        var id = HEAP32[renderbuffers + i * 4 >> 2];
        var renderbuffer = GL.renderbuffers[id];
        if (!renderbuffer) continue;
        GLctx.deleteRenderbuffer(renderbuffer);
        renderbuffer.name = 0;
        GL.renderbuffers[id] = null
    }
}

function _emscripten_glDeleteShader(id) {
    if (!id) return;
    var shader = GL.shaders[id];
    if (!shader) { GL.recordError(1281); return }
    GLctx.deleteShader(shader);
    GL.shaders[id] = null
}

function _emscripten_glDeleteTextures(n, textures) {
    for (var i = 0; i < n; i++) {
        var id = HEAP32[textures + i * 4 >> 2];
        var texture = GL.textures[id];
        if (!texture) continue;
        GLctx.deleteTexture(texture);
        texture.name = 0;
        GL.textures[id] = null
    }
}

function _emscripten_glDeleteVertexArrays(n, vaos) {
    for (var i = 0; i < n; i++) {
        var id = HEAP32[vaos + i * 4 >> 2];
        GLctx["deleteVertexArray"](GL.vaos[id]);
        GL.vaos[id] = null
    }
}

function _emscripten_glDepthFunc(x0) { GLctx["depthFunc"](x0) }

function _emscripten_glDepthMask(flag) { GLctx.depthMask(!!flag) }

function _emscripten_glDepthRange(x0, x1) { GLctx["depthRange"](x0, x1) }

function _emscripten_glDepthRangef(x0, x1) { GLctx["depthRange"](x0, x1) }

function _emscripten_glDetachObjectARB() {
    err("missing function: emscripten_glDetachObjectARB");
    abort(-1)
}

function _emscripten_glDetachShader(program, shader) { GLctx.detachShader(GL.programs[program], GL.shaders[shader]) }

function _emscripten_glDisable(x0) { GLctx["disable"](x0) }

function _emscripten_glDisableClientState() {
    err("missing function: emscripten_glDisableClientState");
    abort(-1)
}

function _emscripten_glDisableVertexAttribArray(index) { GLctx.disableVertexAttribArray(index) }

function _emscripten_glDisablei() {
    err("missing function: emscripten_glDisablei");
    abort(-1)
}

function _emscripten_glDrawArrays(mode, first, count) { GLctx.drawArrays(mode, first, count) }

function _emscripten_glDrawArraysInstanced(mode, first, count, primcount) { GLctx["drawArraysInstanced"](mode, first, count, primcount) }

function _emscripten_glDrawBuffer() {
    err("missing function: emscripten_glDrawBuffer");
    abort(-1)
}

function _emscripten_glDrawBuffers(n, bufs) {
    var bufArray = GL.tempFixedLengthArray[n];
    for (var i = 0; i < n; i++) { bufArray[i] = HEAP32[bufs + i * 4 >> 2] }
    GLctx["drawBuffers"](bufArray)
}

function _emscripten_glDrawElements(mode, count, type, indices) { GLctx.drawElements(mode, count, type, indices) }

function _emscripten_glDrawElementsInstanced(mode, count, type, indices, primcount) { GLctx["drawElementsInstanced"](mode, count, type, indices, primcount) }

function _emscripten_glDrawPixels() {
    err("missing function: emscripten_glDrawPixels");
    abort(-1)
}

function _emscripten_glDrawRangeElements() {
    err("missing function: emscripten_glDrawRangeElements");
    abort(-1)
}

function _emscripten_glEdgeFlag() {
    err("missing function: emscripten_glEdgeFlag");
    abort(-1)
}

function _emscripten_glEdgeFlagPointer() {
    err("missing function: emscripten_glEdgeFlagPointer");
    abort(-1)
}

function _emscripten_glEdgeFlagv() {
    err("missing function: emscripten_glEdgeFlagv");
    abort(-1)
}

function _emscripten_glEnable(x0) { GLctx["enable"](x0) }

function _emscripten_glEnableClientState() {
    err("missing function: emscripten_glEnableClientState");
    abort(-1)
}

function _emscripten_glEnableVertexAttribArray(index) { GLctx.enableVertexAttribArray(index) }

function _emscripten_glEnablei() {
    err("missing function: emscripten_glEnablei");
    abort(-1)
}

function _emscripten_glEnd() {
    err("missing function: emscripten_glEnd");
    abort(-1)
}

function _emscripten_glEndConditionalRender() {
    err("missing function: emscripten_glEndConditionalRender");
    abort(-1)
}

function _emscripten_glEndList() {
    err("missing function: emscripten_glEndList");
    abort(-1)
}

function _emscripten_glEndQuery() {
    err("missing function: emscripten_glEndQuery");
    abort(-1)
}

function _emscripten_glEndTransformFeedback() {
    err("missing function: emscripten_glEndTransformFeedback");
    abort(-1)
}

function _emscripten_glEvalCoord1d() {
    err("missing function: emscripten_glEvalCoord1d");
    abort(-1)
}

function _emscripten_glEvalCoord1dv() {
    err("missing function: emscripten_glEvalCoord1dv");
    abort(-1)
}

function _emscripten_glEvalCoord1f() {
    err("missing function: emscripten_glEvalCoord1f");
    abort(-1)
}

function _emscripten_glEvalCoord1fv() {
    err("missing function: emscripten_glEvalCoord1fv");
    abort(-1)
}

function _emscripten_glEvalCoord2d() {
    err("missing function: emscripten_glEvalCoord2d");
    abort(-1)
}

function _emscripten_glEvalCoord2dv() {
    err("missing function: emscripten_glEvalCoord2dv");
    abort(-1)
}

function _emscripten_glEvalCoord2f() {
    err("missing function: emscripten_glEvalCoord2f");
    abort(-1)
}

function _emscripten_glEvalCoord2fv() {
    err("missing function: emscripten_glEvalCoord2fv");
    abort(-1)
}

function _emscripten_glEvalMesh1() {
    err("missing function: emscripten_glEvalMesh1");
    abort(-1)
}

function _emscripten_glEvalMesh2() {
    err("missing function: emscripten_glEvalMesh2");
    abort(-1)
}

function _emscripten_glEvalPoint1() {
    err("missing function: emscripten_glEvalPoint1");
    abort(-1)
}

function _emscripten_glEvalPoint2() {
    err("missing function: emscripten_glEvalPoint2");
    abort(-1)
}

function _emscripten_glFeedbackBuffer() {
    err("missing function: emscripten_glFeedbackBuffer");
    abort(-1)
}

function _emscripten_glFinish() { GLctx["finish"]() }

function _emscripten_glFlush() { GLctx["flush"]() }

function _emscripten_glFogCoordPointer() {
    err("missing function: emscripten_glFogCoordPointer");
    abort(-1)
}

function _emscripten_glFogCoordd() {
    err("missing function: emscripten_glFogCoordd");
    abort(-1)
}

function _emscripten_glFogCoorddv() {
    err("missing function: emscripten_glFogCoorddv");
    abort(-1)
}

function _emscripten_glFogCoordf() {
    err("missing function: emscripten_glFogCoordf");
    abort(-1)
}

function _emscripten_glFogCoordfv() {
    err("missing function: emscripten_glFogCoordfv");
    abort(-1)
}

function _emscripten_glFogf() {
    err("missing function: emscripten_glFogf");
    abort(-1)
}

function _emscripten_glFogfv() {
    err("missing function: emscripten_glFogfv");
    abort(-1)
}

function _emscripten_glFogi() {
    err("missing function: emscripten_glFogi");
    abort(-1)
}

function _emscripten_glFogiv() {
    err("missing function: emscripten_glFogiv");
    abort(-1)
}

function _emscripten_glFramebufferRenderbuffer(target, attachment, renderbuffertarget, renderbuffer) { GLctx.framebufferRenderbuffer(target, attachment, renderbuffertarget, GL.renderbuffers[renderbuffer]) }

function _emscripten_glFramebufferTexture1D() {
    err("missing function: emscripten_glFramebufferTexture1D");
    abort(-1)
}

function _emscripten_glFramebufferTexture2D(target, attachment, textarget, texture, level) { GLctx.framebufferTexture2D(target, attachment, textarget, GL.textures[texture], level) }

function _emscripten_glFramebufferTexture3D() {
    err("missing function: emscripten_glFramebufferTexture3D");
    abort(-1)
}

function _emscripten_glFramebufferTextureLayer() {
    err("missing function: emscripten_glFramebufferTextureLayer");
    abort(-1)
}

function _emscripten_glFrontFace(x0) { GLctx["frontFace"](x0) }

function _emscripten_glFrustum() {
    err("missing function: emscripten_glFrustum");
    abort(-1)
}

function _emscripten_glGenBuffers(n, buffers) {
    for (var i = 0; i < n; i++) {
        var buffer = GLctx.createBuffer();
        if (!buffer) { GL.recordError(1282); while (i < n) HEAP32[buffers + i++ * 4 >> 2] = 0; return }
        var id = GL.getNewId(GL.buffers);
        buffer.name = id;
        GL.buffers[id] = buffer;
        HEAP32[buffers + i * 4 >> 2] = id
    }
}

function _emscripten_glGenFramebuffers(n, ids) {
    for (var i = 0; i < n; ++i) {
        var framebuffer = GLctx.createFramebuffer();
        if (!framebuffer) { GL.recordError(1282); while (i < n) HEAP32[ids + i++ * 4 >> 2] = 0; return }
        var id = GL.getNewId(GL.framebuffers);
        framebuffer.name = id;
        GL.framebuffers[id] = framebuffer;
        HEAP32[ids + i * 4 >> 2] = id
    }
}

function _emscripten_glGenLists() {
    err("missing function: emscripten_glGenLists");
    abort(-1)
}

function _emscripten_glGenProgramsARB() {
    err("missing function: emscripten_glGenProgramsARB");
    abort(-1)
}

function _emscripten_glGenQueries() {
    err("missing function: emscripten_glGenQueries");
    abort(-1)
}

function _emscripten_glGenRenderbuffers(n, renderbuffers) {
    for (var i = 0; i < n; i++) {
        var renderbuffer = GLctx.createRenderbuffer();
        if (!renderbuffer) { GL.recordError(1282); while (i < n) HEAP32[renderbuffers + i++ * 4 >> 2] = 0; return }
        var id = GL.getNewId(GL.renderbuffers);
        renderbuffer.name = id;
        GL.renderbuffers[id] = renderbuffer;
        HEAP32[renderbuffers + i * 4 >> 2] = id
    }
}

function _emscripten_glGenTextures(n, textures) {
    for (var i = 0; i < n; i++) {
        var texture = GLctx.createTexture();
        if (!texture) { GL.recordError(1282); while (i < n) HEAP32[textures + i++ * 4 >> 2] = 0; return }
        var id = GL.getNewId(GL.textures);
        texture.name = id;
        GL.textures[id] = texture;
        HEAP32[textures + i * 4 >> 2] = id
    }
}

function _emscripten_glGenVertexArrays(n, arrays) {
    for (var i = 0; i < n; i++) {
        var vao = GLctx["createVertexArray"]();
        if (!vao) { GL.recordError(1282); while (i < n) HEAP32[arrays + i++ * 4 >> 2] = 0; return }
        var id = GL.getNewId(GL.vaos);
        vao.name = id;
        GL.vaos[id] = vao;
        HEAP32[arrays + i * 4 >> 2] = id
    }
}

function _emscripten_glGenerateMipmap(x0) { GLctx["generateMipmap"](x0) }

function _emscripten_glGetActiveAttrib(program, index, bufSize, length, size, type, name) { program = GL.programs[program]; var info = GLctx.getActiveAttrib(program, index); if (!info) return; if (bufSize > 0 && name) { var numBytesWrittenExclNull = stringToUTF8(info.name, name, bufSize); if (length) HEAP32[length >> 2] = numBytesWrittenExclNull } else { if (length) HEAP32[length >> 2] = 0 } if (size) HEAP32[size >> 2] = info.size; if (type) HEAP32[type >> 2] = info.type }

function _emscripten_glGetActiveUniform(program, index, bufSize, length, size, type, name) { program = GL.programs[program]; var info = GLctx.getActiveUniform(program, index); if (!info) return; if (bufSize > 0 && name) { var numBytesWrittenExclNull = stringToUTF8(info.name, name, bufSize); if (length) HEAP32[length >> 2] = numBytesWrittenExclNull } else { if (length) HEAP32[length >> 2] = 0 } if (size) HEAP32[size >> 2] = info.size; if (type) HEAP32[type >> 2] = info.type }

function _emscripten_glGetActiveUniformBlockName() {
    err("missing function: emscripten_glGetActiveUniformBlockName");
    abort(-1)
}

function _emscripten_glGetActiveUniformBlockiv() {
    err("missing function: emscripten_glGetActiveUniformBlockiv");
    abort(-1)
}

function _emscripten_glGetActiveUniformName() {
    err("missing function: emscripten_glGetActiveUniformName");
    abort(-1)
}

function _emscripten_glGetActiveUniformsiv() {
    err("missing function: emscripten_glGetActiveUniformsiv");
    abort(-1)
}

function _emscripten_glGetAttachedObjectsARB() {
    err("missing function: emscripten_glGetAttachedObjectsARB");
    abort(-1)
}

function _emscripten_glGetAttachedShaders(program, maxCount, count, shaders) {
    var result = GLctx.getAttachedShaders(GL.programs[program]);
    var len = result.length;
    if (len > maxCount) { len = maxCount }
    HEAP32[count >> 2] = len;
    for (var i = 0; i < len; ++i) {
        var id = GL.shaders.indexOf(result[i]);
        HEAP32[shaders + i * 4 >> 2] = id
    }
}

function _emscripten_glGetAttribLocation(program, name) { return GLctx.getAttribLocation(GL.programs[program], Pointer_stringify(name)) }

function _emscripten_glGetBooleani_v() {
    err("missing function: emscripten_glGetBooleani_v");
    abort(-1)
}

function emscriptenWebGLGet(name_, p, type) {
    if (!p) { GL.recordError(1281); return }
    var ret = undefined;
    switch (name_) {
        case 36346:
            ret = 1;
            break;
        case 36344:
            if (type !== "Integer" && type !== "Integer64") { GL.recordError(1280) }
            return;
        case 36345:
            ret = 0;
            break;
        case 34466:
            var formats = GLctx.getParameter(34467);
            ret = formats ? formats.length : 0;
            break
    }
    if (ret === undefined) {
        var result = GLctx.getParameter(name_);
        switch (typeof result) {
            case "number":
                ret = result;
                break;
            case "boolean":
                ret = result ? 1 : 0;
                break;
            case "string":
                GL.recordError(1280);
                return;
            case "object":
                if (result === null) {
                    switch (name_) {
                        case 34964:
                        case 35725:
                        case 34965:
                        case 36006:
                        case 36007:
                        case 32873:
                        case 34068:
                            { ret = 0; break };
                        default:
                            { GL.recordError(1280); return }
                    }
                } else if (result instanceof Float32Array || result instanceof Uint32Array || result instanceof Int32Array || result instanceof Array) {
                    for (var i = 0; i < result.length; ++i) {
                        switch (type) {
                            case "Integer":
                                HEAP32[p + i * 4 >> 2] = result[i];
                                break;
                            case "Float":
                                HEAPF32[p + i * 4 >> 2] = result[i];
                                break;
                            case "Boolean":
                                HEAP8[p + i >> 0] = result[i] ? 1 : 0;
                                break;
                            default:
                                throw "internal glGet error, bad type: " + type
                        }
                    }
                    return
                } else {
                    try { ret = result.name | 0 } catch (e) {
                        GL.recordError(1280);
                        err("GL_INVALID_ENUM in glGet" + type + "v: Unknown object returned from WebGL getParameter(" + name_ + ")! (error: " + e + ")");
                        return
                    }
                }
                break;
            default:
                GL.recordError(1280);
                return
        }
    }
    switch (type) {
        case "Integer64":
            tempI64 = [ret >>> 0, (tempDouble = ret, +Math_abs(tempDouble) >= +1 ? tempDouble > +0 ? (Math_min(+Math_floor(tempDouble / +4294967296), +4294967295) | 0) >>> 0 : ~~+Math_ceil((tempDouble - +(~~tempDouble >>> 0)) / +4294967296) >>> 0 : 0)], HEAP32[p >> 2] = tempI64[0], HEAP32[p + 4 >> 2] = tempI64[1];
            break;
        case "Integer":
            HEAP32[p >> 2] = ret;
            break;
        case "Float":
            HEAPF32[p >> 2] = ret;
            break;
        case "Boolean":
            HEAP8[p >> 0] = ret ? 1 : 0;
            break;
        default:
            throw "internal glGet error, bad type: " + type
    }
}

function _emscripten_glGetBooleanv(name_, p) { emscriptenWebGLGet(name_, p, "Boolean") }

function _emscripten_glGetBufferParameteriv(target, value, data) {
    if (!data) { GL.recordError(1281); return }
    HEAP32[data >> 2] = GLctx.getBufferParameter(target, value)
}

function _emscripten_glGetBufferPointerv() {
    err("missing function: emscripten_glGetBufferPointerv");
    abort(-1)
}

function _emscripten_glGetBufferSubData() {
    err("missing function: emscripten_glGetBufferSubData");
    abort(-1)
}

function _emscripten_glGetClipPlane() {
    err("missing function: emscripten_glGetClipPlane");
    abort(-1)
}

function _emscripten_glGetColorTable() {
    err("missing function: emscripten_glGetColorTable");
    abort(-1)
}

function _emscripten_glGetColorTableParameterfv() {
    err("missing function: emscripten_glGetColorTableParameterfv");
    abort(-1)
}

function _emscripten_glGetColorTableParameteriv() {
    err("missing function: emscripten_glGetColorTableParameteriv");
    abort(-1)
}

function _emscripten_glGetCompressedTexImage() {
    err("missing function: emscripten_glGetCompressedTexImage");
    abort(-1)
}

function _emscripten_glGetConvolutionFilter() {
    err("missing function: emscripten_glGetConvolutionFilter");
    abort(-1)
}

function _emscripten_glGetConvolutionParameterfv() {
    err("missing function: emscripten_glGetConvolutionParameterfv");
    abort(-1)
}

function _emscripten_glGetConvolutionParameteriv() {
    err("missing function: emscripten_glGetConvolutionParameteriv");
    abort(-1)
}

function _emscripten_glGetDoublev() {
    err("missing function: emscripten_glGetDoublev");
    abort(-1)
}

function _emscripten_glGetError() {
    if (GL.lastError) {
        var error = GL.lastError;
        GL.lastError = 0;
        return error
    } else { return GLctx.getError() }
}

function _emscripten_glGetFloatv(name_, p) { emscriptenWebGLGet(name_, p, "Float") }

function _emscripten_glGetFragDataLocation() {
    err("missing function: emscripten_glGetFragDataLocation");
    abort(-1)
}

function _emscripten_glGetFramebufferAttachmentParameteriv(target, attachment, pname, params) {
    var result = GLctx.getFramebufferAttachmentParameter(target, attachment, pname);
    if (result instanceof WebGLRenderbuffer || result instanceof WebGLTexture) { result = result.name | 0 }
    HEAP32[params >> 2] = result
}

function _emscripten_glGetHandleARB() {
    err("missing function: emscripten_glGetHandleARB");
    abort(-1)
}

function _emscripten_glGetHistogram() {
    err("missing function: emscripten_glGetHistogram");
    abort(-1)
}

function _emscripten_glGetHistogramParameterfv() {
    err("missing function: emscripten_glGetHistogramParameterfv");
    abort(-1)
}

function _emscripten_glGetHistogramParameteriv() {
    err("missing function: emscripten_glGetHistogramParameteriv");
    abort(-1)
}

function _emscripten_glGetInfoLogARB() {
    err("missing function: emscripten_glGetInfoLogARB");
    abort(-1)
}

function _emscripten_glGetIntegeri_v() {
    err("missing function: emscripten_glGetIntegeri_v");
    abort(-1)
}

function _emscripten_glGetIntegerv(name_, p) { emscriptenWebGLGet(name_, p, "Integer") }

function _emscripten_glGetLightfv() {
    err("missing function: emscripten_glGetLightfv");
    abort(-1)
}

function _emscripten_glGetLightiv() {
    err("missing function: emscripten_glGetLightiv");
    abort(-1)
}

function _emscripten_glGetMapdv() {
    err("missing function: emscripten_glGetMapdv");
    abort(-1)
}

function _emscripten_glGetMapfv() {
    err("missing function: emscripten_glGetMapfv");
    abort(-1)
}

function _emscripten_glGetMapiv() {
    err("missing function: emscripten_glGetMapiv");
    abort(-1)
}

function _emscripten_glGetMaterialfv() {
    err("missing function: emscripten_glGetMaterialfv");
    abort(-1)
}

function _emscripten_glGetMaterialiv() {
    err("missing function: emscripten_glGetMaterialiv");
    abort(-1)
}

function _emscripten_glGetMinmax() {
    err("missing function: emscripten_glGetMinmax");
    abort(-1)
}

function _emscripten_glGetMinmaxParameterfv() {
    err("missing function: emscripten_glGetMinmaxParameterfv");
    abort(-1)
}

function _emscripten_glGetMinmaxParameteriv() {
    err("missing function: emscripten_glGetMinmaxParameteriv");
    abort(-1)
}

function _emscripten_glGetObjectParameterfvARB() {
    err("missing function: emscripten_glGetObjectParameterfvARB");
    abort(-1)
}

function _emscripten_glGetObjectParameterivARB() {
    err("missing function: emscripten_glGetObjectParameterivARB");
    abort(-1)
}

function _emscripten_glGetPixelMapfv() {
    err("missing function: emscripten_glGetPixelMapfv");
    abort(-1)
}

function _emscripten_glGetPixelMapuiv() {
    err("missing function: emscripten_glGetPixelMapuiv");
    abort(-1)
}

function _emscripten_glGetPixelMapusv() {
    err("missing function: emscripten_glGetPixelMapusv");
    abort(-1)
}

function _emscripten_glGetPointerv() {
    err("missing function: emscripten_glGetPointerv");
    abort(-1)
}

function _emscripten_glGetPolygonStipple() {
    err("missing function: emscripten_glGetPolygonStipple");
    abort(-1)
}

function _emscripten_glGetProgramEnvParameterdvARB() {
    err("missing function: emscripten_glGetProgramEnvParameterdvARB");
    abort(-1)
}

function _emscripten_glGetProgramEnvParameterfvARB() {
    err("missing function: emscripten_glGetProgramEnvParameterfvARB");
    abort(-1)
}

function _emscripten_glGetProgramInfoLog(program, maxLength, length, infoLog) { var log = GLctx.getProgramInfoLog(GL.programs[program]); if (log === null) log = "(unknown error)"; if (maxLength > 0 && infoLog) { var numBytesWrittenExclNull = stringToUTF8(log, infoLog, maxLength); if (length) HEAP32[length >> 2] = numBytesWrittenExclNull } else { if (length) HEAP32[length >> 2] = 0 } }

function _emscripten_glGetProgramLocalParameterdvARB() {
    err("missing function: emscripten_glGetProgramLocalParameterdvARB");
    abort(-1)
}

function _emscripten_glGetProgramLocalParameterfvARB() {
    err("missing function: emscripten_glGetProgramLocalParameterfvARB");
    abort(-1)
}

function _emscripten_glGetProgramStringARB() {
    err("missing function: emscripten_glGetProgramStringARB");
    abort(-1)
}

function _emscripten_glGetProgramiv(program, pname, p) {
    if (!p) { GL.recordError(1281); return }
    if (program >= GL.counter) { GL.recordError(1281); return }
    var ptable = GL.programInfos[program];
    if (!ptable) { GL.recordError(1282); return }
    if (pname == 35716) {
        var log = GLctx.getProgramInfoLog(GL.programs[program]);
        if (log === null) log = "(unknown error)";
        HEAP32[p >> 2] = log.length + 1
    } else if (pname == 35719) { HEAP32[p >> 2] = ptable.maxUniformLength } else if (pname == 35722) {
        if (ptable.maxAttributeLength == -1) {
            program = GL.programs[program];
            var numAttribs = GLctx.getProgramParameter(program, GLctx.ACTIVE_ATTRIBUTES);
            ptable.maxAttributeLength = 0;
            for (var i = 0; i < numAttribs; ++i) {
                var activeAttrib = GLctx.getActiveAttrib(program, i);
                ptable.maxAttributeLength = Math.max(ptable.maxAttributeLength, activeAttrib.name.length + 1)
            }
        }
        HEAP32[p >> 2] = ptable.maxAttributeLength
    } else if (pname == 35381) {
        if (ptable.maxUniformBlockNameLength == -1) {
            program = GL.programs[program];
            var numBlocks = GLctx.getProgramParameter(program, GLctx.ACTIVE_UNIFORM_BLOCKS);
            ptable.maxUniformBlockNameLength = 0;
            for (var i = 0; i < numBlocks; ++i) {
                var activeBlockName = GLctx.getActiveUniformBlockName(program, i);
                ptable.maxUniformBlockNameLength = Math.max(ptable.maxUniformBlockNameLength, activeBlockName.length + 1)
            }
        }
        HEAP32[p >> 2] = ptable.maxUniformBlockNameLength
    } else { HEAP32[p >> 2] = GLctx.getProgramParameter(GL.programs[program], pname) }
}

function _emscripten_glGetQueryObjectiv() {
    err("missing function: emscripten_glGetQueryObjectiv");
    abort(-1)
}

function _emscripten_glGetQueryObjectuiv() {
    err("missing function: emscripten_glGetQueryObjectuiv");
    abort(-1)
}

function _emscripten_glGetQueryiv() {
    err("missing function: emscripten_glGetQueryiv");
    abort(-1)
}

function _emscripten_glGetRenderbufferParameteriv(target, pname, params) {
    if (!params) { GL.recordError(1281); return }
    HEAP32[params >> 2] = GLctx.getRenderbufferParameter(target, pname)
}

function _emscripten_glGetSeparableFilter() {
    err("missing function: emscripten_glGetSeparableFilter");
    abort(-1)
}

function _emscripten_glGetShaderInfoLog(shader, maxLength, length, infoLog) { var log = GLctx.getShaderInfoLog(GL.shaders[shader]); if (log === null) log = "(unknown error)"; if (maxLength > 0 && infoLog) { var numBytesWrittenExclNull = stringToUTF8(log, infoLog, maxLength); if (length) HEAP32[length >> 2] = numBytesWrittenExclNull } else { if (length) HEAP32[length >> 2] = 0 } }

function _emscripten_glGetShaderPrecisionFormat(shaderType, precisionType, range, precision) {
    var result = GLctx.getShaderPrecisionFormat(shaderType, precisionType);
    HEAP32[range >> 2] = result.rangeMin;
    HEAP32[range + 4 >> 2] = result.rangeMax;
    HEAP32[precision >> 2] = result.precision
}

function _emscripten_glGetShaderSource(shader, bufSize, length, source) { var result = GLctx.getShaderSource(GL.shaders[shader]); if (!result) return; if (bufSize > 0 && source) { var numBytesWrittenExclNull = stringToUTF8(result, source, bufSize); if (length) HEAP32[length >> 2] = numBytesWrittenExclNull } else { if (length) HEAP32[length >> 2] = 0 } }

function _emscripten_glGetShaderiv(shader, pname, p) {
    if (!p) { GL.recordError(1281); return }
    if (pname == 35716) {
        var log = GLctx.getShaderInfoLog(GL.shaders[shader]);
        if (log === null) log = "(unknown error)";
        HEAP32[p >> 2] = log.length + 1
    } else if (pname == 35720) {
        var source = GLctx.getShaderSource(GL.shaders[shader]);
        var sourceLength = source === null || source.length == 0 ? 0 : source.length + 1;
        HEAP32[p >> 2] = sourceLength
    } else { HEAP32[p >> 2] = GLctx.getShaderParameter(GL.shaders[shader], pname) }
}

function _emscripten_glGetString(name_) {
    if (GL.stringCache[name_]) return GL.stringCache[name_];
    var ret;
    switch (name_) {
        case 7939:
            var exts = GLctx.getSupportedExtensions();
            var gl_exts = [];
            for (var i = 0; i < exts.length; ++i) {
                gl_exts.push(exts[i]);
                gl_exts.push("GL_" + exts[i])
            }
            ret = allocate(intArrayFromString(gl_exts.join(" ")), "i8", ALLOC_NORMAL);
            break;
        case 7936:
        case 7937:
        case 37445:
        case 37446:
            var s = GLctx.getParameter(name_);
            if (!s) { GL.recordError(1280) }
            ret = allocate(intArrayFromString(s), "i8", ALLOC_NORMAL);
            break;
        case 7938:
            var glVersion = GLctx.getParameter(GLctx.VERSION); { glVersion = "OpenGL ES 2.0 (" + glVersion + ")" }
            ret = allocate(intArrayFromString(glVersion), "i8", ALLOC_NORMAL);
            break;
        case 35724:
            var glslVersion = GLctx.getParameter(GLctx.SHADING_LANGUAGE_VERSION);
            var ver_re = /^WebGL GLSL ES ([0-9]\.[0-9][0-9]?)(?:$| .*)/;
            var ver_num = glslVersion.match(ver_re);
            if (ver_num !== null) {
                if (ver_num[1].length == 3) ver_num[1] = ver_num[1] + "0";
                glslVersion = "OpenGL ES GLSL ES " + ver_num[1] + " (" + glslVersion + ")"
            }
            ret = allocate(intArrayFromString(glslVersion), "i8", ALLOC_NORMAL);
            break;
        default:
            GL.recordError(1280);
            return 0
    }
    GL.stringCache[name_] = ret;
    return ret
}

function _emscripten_glGetStringi() {
    err("missing function: emscripten_glGetStringi");
    abort(-1)
}

function _emscripten_glGetTexEnvfv() {
    err("missing function: emscripten_glGetTexEnvfv");
    abort(-1)
}

function _emscripten_glGetTexEnviv() {
    err("missing function: emscripten_glGetTexEnviv");
    abort(-1)
}

function _emscripten_glGetTexGendv() {
    err("missing function: emscripten_glGetTexGendv");
    abort(-1)
}

function _emscripten_glGetTexGenfv() {
    err("missing function: emscripten_glGetTexGenfv");
    abort(-1)
}

function _emscripten_glGetTexGeniv() {
    err("missing function: emscripten_glGetTexGeniv");
    abort(-1)
}

function _emscripten_glGetTexImage() {
    err("missing function: emscripten_glGetTexImage");
    abort(-1)
}

function _emscripten_glGetTexLevelParameterfv() {
    err("missing function: emscripten_glGetTexLevelParameterfv");
    abort(-1)
}

function _emscripten_glGetTexLevelParameteriv() {
    err("missing function: emscripten_glGetTexLevelParameteriv");
    abort(-1)
}

function _emscripten_glGetTexParameterIiv() {
    err("missing function: emscripten_glGetTexParameterIiv");
    abort(-1)
}

function _emscripten_glGetTexParameterIuiv() {
    err("missing function: emscripten_glGetTexParameterIuiv");
    abort(-1)
}

function _emscripten_glGetTexParameterfv(target, pname, params) {
    if (!params) { GL.recordError(1281); return }
    HEAPF32[params >> 2] = GLctx.getTexParameter(target, pname)
}

function _emscripten_glGetTexParameteriv(target, pname, params) {
    if (!params) { GL.recordError(1281); return }
    HEAP32[params >> 2] = GLctx.getTexParameter(target, pname)
}

function _emscripten_glGetTransformFeedbackVarying() {
    err("missing function: emscripten_glGetTransformFeedbackVarying");
    abort(-1)
}

function _emscripten_glGetUniformBlockIndex() {
    err("missing function: emscripten_glGetUniformBlockIndex");
    abort(-1)
}

function _emscripten_glGetUniformIndices() {
    err("missing function: emscripten_glGetUniformIndices");
    abort(-1)
}

function _emscripten_glGetUniformLocation(program, name) {
    name = Pointer_stringify(name);
    var arrayOffset = 0;
    if (name.indexOf("]", name.length - 1) !== -1) {
        var ls = name.lastIndexOf("[");
        var arrayIndex = name.slice(ls + 1, -1);
        if (arrayIndex.length > 0) { arrayOffset = parseInt(arrayIndex); if (arrayOffset < 0) { return -1 } }
        name = name.slice(0, ls)
    }
    var ptable = GL.programInfos[program];
    if (!ptable) { return -1 }
    var utable = ptable.uniforms;
    var uniformInfo = utable[name];
    if (uniformInfo && arrayOffset < uniformInfo[0]) { return uniformInfo[1] + arrayOffset } else { return -1 }
}

function emscriptenWebGLGetUniform(program, location, params, type) {
    if (!params) { GL.recordError(1281); return }
    var data = GLctx.getUniform(GL.programs[program], GL.uniforms[location]);
    if (typeof data == "number" || typeof data == "boolean") {
        switch (type) {
            case "Integer":
                HEAP32[params >> 2] = data;
                break;
            case "Float":
                HEAPF32[params >> 2] = data;
                break;
            default:
                throw "internal emscriptenWebGLGetUniform() error, bad type: " + type
        }
    } else {
        for (var i = 0; i < data.length; i++) {
            switch (type) {
                case "Integer":
                    HEAP32[params + i * 4 >> 2] = data[i];
                    break;
                case "Float":
                    HEAPF32[params + i * 4 >> 2] = data[i];
                    break;
                default:
                    throw "internal emscriptenWebGLGetUniform() error, bad type: " + type
            }
        }
    }
}

function _emscripten_glGetUniformfv(program, location, params) { emscriptenWebGLGetUniform(program, location, params, "Float") }

function _emscripten_glGetUniformiv(program, location, params) { emscriptenWebGLGetUniform(program, location, params, "Integer") }

function _emscripten_glGetUniformuiv() {
    err("missing function: emscripten_glGetUniformuiv");
    abort(-1)
}

function _emscripten_glGetVertexAttribIiv() {
    err("missing function: emscripten_glGetVertexAttribIiv");
    abort(-1)
}

function _emscripten_glGetVertexAttribIuiv() {
    err("missing function: emscripten_glGetVertexAttribIuiv");
    abort(-1)
}

function _emscripten_glGetVertexAttribPointerv(index, pname, pointer) {
    if (!pointer) { GL.recordError(1281); return }
    HEAP32[pointer >> 2] = GLctx.getVertexAttribOffset(index, pname)
}

function _emscripten_glGetVertexAttribdv() {
    err("missing function: emscripten_glGetVertexAttribdv");
    abort(-1)
}

function emscriptenWebGLGetVertexAttrib(index, pname, params, type) {
    if (!params) { GL.recordError(1281); return }
    var data = GLctx.getVertexAttrib(index, pname);
    if (pname == 34975) { HEAP32[params >> 2] = data["name"] } else if (typeof data == "number" || typeof data == "boolean") {
        switch (type) {
            case "Integer":
                HEAP32[params >> 2] = data;
                break;
            case "Float":
                HEAPF32[params >> 2] = data;
                break;
            case "FloatToInteger":
                HEAP32[params >> 2] = Math.fround(data);
                break;
            default:
                throw "internal emscriptenWebGLGetVertexAttrib() error, bad type: " + type
        }
    } else {
        for (var i = 0; i < data.length; i++) {
            switch (type) {
                case "Integer":
                    HEAP32[params + i * 4 >> 2] = data[i];
                    break;
                case "Float":
                    HEAPF32[params + i * 4 >> 2] = data[i];
                    break;
                case "FloatToInteger":
                    HEAP32[params + i * 4 >> 2] = Math.fround(data[i]);
                    break;
                default:
                    throw "internal emscriptenWebGLGetVertexAttrib() error, bad type: " + type
            }
        }
    }
}

function _emscripten_glGetVertexAttribfv(index, pname, params) { emscriptenWebGLGetVertexAttrib(index, pname, params, "Float") }

function _emscripten_glGetVertexAttribiv(index, pname, params) { emscriptenWebGLGetVertexAttrib(index, pname, params, "FloatToInteger") }

function _emscripten_glHint(x0, x1) { GLctx["hint"](x0, x1) }

function _emscripten_glHistogram() {
    err("missing function: emscripten_glHistogram");
    abort(-1)
}

function _emscripten_glIndexMask() {
    err("missing function: emscripten_glIndexMask");
    abort(-1)
}

function _emscripten_glIndexPointer() {
    err("missing function: emscripten_glIndexPointer");
    abort(-1)
}

function _emscripten_glIndexd() {
    err("missing function: emscripten_glIndexd");
    abort(-1)
}

function _emscripten_glIndexdv() {
    err("missing function: emscripten_glIndexdv");
    abort(-1)
}

function _emscripten_glIndexf() {
    err("missing function: emscripten_glIndexf");
    abort(-1)
}

function _emscripten_glIndexfv() {
    err("missing function: emscripten_glIndexfv");
    abort(-1)
}

function _emscripten_glIndexi() {
    err("missing function: emscripten_glIndexi");
    abort(-1)
}

function _emscripten_glIndexiv() {
    err("missing function: emscripten_glIndexiv");
    abort(-1)
}

function _emscripten_glIndexs() {
    err("missing function: emscripten_glIndexs");
    abort(-1)
}

function _emscripten_glIndexsv() {
    err("missing function: emscripten_glIndexsv");
    abort(-1)
}

function _emscripten_glIndexub() {
    err("missing function: emscripten_glIndexub");
    abort(-1)
}

function _emscripten_glIndexubv() {
    err("missing function: emscripten_glIndexubv");
    abort(-1)
}

function _emscripten_glInitNames() {
    err("missing function: emscripten_glInitNames");
    abort(-1)
}

function _emscripten_glInterleavedArrays() {
    err("missing function: emscripten_glInterleavedArrays");
    abort(-1)
}

function _emscripten_glIsBuffer(buffer) { var b = GL.buffers[buffer]; if (!b) return 0; return GLctx.isBuffer(b) }

function _emscripten_glIsEnabled(x0) { return GLctx["isEnabled"](x0) }

function _emscripten_glIsEnabledi() {
    err("missing function: emscripten_glIsEnabledi");
    abort(-1)
}

function _emscripten_glIsFramebuffer(framebuffer) { var fb = GL.framebuffers[framebuffer]; if (!fb) return 0; return GLctx.isFramebuffer(fb) }

function _emscripten_glIsList() {
    err("missing function: emscripten_glIsList");
    abort(-1)
}

function _emscripten_glIsProgram(program) { program = GL.programs[program]; if (!program) return 0; return GLctx.isProgram(program) }

function _emscripten_glIsQuery() {
    err("missing function: emscripten_glIsQuery");
    abort(-1)
}

function _emscripten_glIsRenderbuffer(renderbuffer) { var rb = GL.renderbuffers[renderbuffer]; if (!rb) return 0; return GLctx.isRenderbuffer(rb) }

function _emscripten_glIsShader(shader) { var s = GL.shaders[shader]; if (!s) return 0; return GLctx.isShader(s) }

function _emscripten_glIsTexture(texture) { var texture = GL.textures[texture]; if (!texture) return 0; return GLctx.isTexture(texture) }

function _emscripten_glIsVertexArray(array) { var vao = GL.vaos[array]; if (!vao) return 0; return GLctx["isVertexArray"](vao) }

function _emscripten_glLightModelf() {
    err("missing function: emscripten_glLightModelf");
    abort(-1)
}

function _emscripten_glLightModelfv() {
    err("missing function: emscripten_glLightModelfv");
    abort(-1)
}

function _emscripten_glLightModeli() {
    err("missing function: emscripten_glLightModeli");
    abort(-1)
}

function _emscripten_glLightModeliv() {
    err("missing function: emscripten_glLightModeliv");
    abort(-1)
}

function _emscripten_glLightf() {
    err("missing function: emscripten_glLightf");
    abort(-1)
}

function _emscripten_glLightfv() {
    err("missing function: emscripten_glLightfv");
    abort(-1)
}

function _emscripten_glLighti() {
    err("missing function: emscripten_glLighti");
    abort(-1)
}

function _emscripten_glLightiv() {
    err("missing function: emscripten_glLightiv");
    abort(-1)
}

function _emscripten_glLineStipple() {
    err("missing function: emscripten_glLineStipple");
    abort(-1)
}

function _emscripten_glLineWidth(x0) { GLctx["lineWidth"](x0) }

function _emscripten_glLinkProgram(program) {
    GLctx.linkProgram(GL.programs[program]);
    GL.programInfos[program] = null;
    GL.populateUniformTable(program)
}

function _emscripten_glListBase() {
    err("missing function: emscripten_glListBase");
    abort(-1)
}

function _emscripten_glLoadIdentity() { throw "Legacy GL function (glLoadIdentity) called. If you want legacy GL emulation, you need to compile with -s LEGACY_GL_EMULATION=1 to enable legacy GL emulation." }

function _emscripten_glLoadMatrixd() {
    err("missing function: emscripten_glLoadMatrixd");
    abort(-1)
}

function _emscripten_glLoadMatrixf() {
    err("missing function: emscripten_glLoadMatrixf");
    abort(-1)
}

function _emscripten_glLoadName() {
    err("missing function: emscripten_glLoadName");
    abort(-1)
}

function _emscripten_glLoadTransposeMatrixd() {
    err("missing function: emscripten_glLoadTransposeMatrixd");
    abort(-1)
}

function _emscripten_glLoadTransposeMatrixf() {
    err("missing function: emscripten_glLoadTransposeMatrixf");
    abort(-1)
}

function _emscripten_glLogicOp() {
    err("missing function: emscripten_glLogicOp");
    abort(-1)
}

function _emscripten_glMap1d() {
    err("missing function: emscripten_glMap1d");
    abort(-1)
}

function _emscripten_glMap1f() {
    err("missing function: emscripten_glMap1f");
    abort(-1)
}

function _emscripten_glMap2d() {
    err("missing function: emscripten_glMap2d");
    abort(-1)
}

function _emscripten_glMap2f() {
    err("missing function: emscripten_glMap2f");
    abort(-1)
}

function _emscripten_glMapBuffer() {
    err("missing function: emscripten_glMapBuffer");
    abort(-1)
}

function _emscripten_glMapGrid1d() {
    err("missing function: emscripten_glMapGrid1d");
    abort(-1)
}

function _emscripten_glMapGrid1f() {
    err("missing function: emscripten_glMapGrid1f");
    abort(-1)
}

function _emscripten_glMapGrid2d() {
    err("missing function: emscripten_glMapGrid2d");
    abort(-1)
}

function _emscripten_glMapGrid2f() {
    err("missing function: emscripten_glMapGrid2f");
    abort(-1)
}

function _emscripten_glMaterialf() {
    err("missing function: emscripten_glMaterialf");
    abort(-1)
}

function _emscripten_glMaterialfv() {
    err("missing function: emscripten_glMaterialfv");
    abort(-1)
}

function _emscripten_glMateriali() {
    err("missing function: emscripten_glMateriali");
    abort(-1)
}

function _emscripten_glMaterialiv() {
    err("missing function: emscripten_glMaterialiv");
    abort(-1)
}

function _emscripten_glMatrixMode() { throw "Legacy GL function (glMatrixMode) called. If you want legacy GL emulation, you need to compile with -s LEGACY_GL_EMULATION=1 to enable legacy GL emulation." }

function _emscripten_glMinmax() {
    err("missing function: emscripten_glMinmax");
    abort(-1)
}

function _emscripten_glMultMatrixd() {
    err("missing function: emscripten_glMultMatrixd");
    abort(-1)
}

function _emscripten_glMultMatrixf() {
    err("missing function: emscripten_glMultMatrixf");
    abort(-1)
}

function _emscripten_glMultTransposeMatrixd() {
    err("missing function: emscripten_glMultTransposeMatrixd");
    abort(-1)
}

function _emscripten_glMultTransposeMatrixf() {
    err("missing function: emscripten_glMultTransposeMatrixf");
    abort(-1)
}

function _emscripten_glMultiDrawArrays() {
    err("missing function: emscripten_glMultiDrawArrays");
    abort(-1)
}

function _emscripten_glMultiDrawElements() {
    err("missing function: emscripten_glMultiDrawElements");
    abort(-1)
}

function _emscripten_glMultiTexCoord1d() {
    err("missing function: emscripten_glMultiTexCoord1d");
    abort(-1)
}

function _emscripten_glMultiTexCoord1dv() {
    err("missing function: emscripten_glMultiTexCoord1dv");
    abort(-1)
}

function _emscripten_glMultiTexCoord1f() {
    err("missing function: emscripten_glMultiTexCoord1f");
    abort(-1)
}

function _emscripten_glMultiTexCoord1fv() {
    err("missing function: emscripten_glMultiTexCoord1fv");
    abort(-1)
}

function _emscripten_glMultiTexCoord1i() {
    err("missing function: emscripten_glMultiTexCoord1i");
    abort(-1)
}

function _emscripten_glMultiTexCoord1iv() {
    err("missing function: emscripten_glMultiTexCoord1iv");
    abort(-1)
}

function _emscripten_glMultiTexCoord1s() {
    err("missing function: emscripten_glMultiTexCoord1s");
    abort(-1)
}

function _emscripten_glMultiTexCoord1sv() {
    err("missing function: emscripten_glMultiTexCoord1sv");
    abort(-1)
}

function _emscripten_glMultiTexCoord2d() {
    err("missing function: emscripten_glMultiTexCoord2d");
    abort(-1)
}

function _emscripten_glMultiTexCoord2dv() {
    err("missing function: emscripten_glMultiTexCoord2dv");
    abort(-1)
}

function _emscripten_glMultiTexCoord2f() {
    err("missing function: emscripten_glMultiTexCoord2f");
    abort(-1)
}

function _emscripten_glMultiTexCoord2fv() {
    err("missing function: emscripten_glMultiTexCoord2fv");
    abort(-1)
}

function _emscripten_glMultiTexCoord2i() {
    err("missing function: emscripten_glMultiTexCoord2i");
    abort(-1)
}

function _emscripten_glMultiTexCoord2iv() {
    err("missing function: emscripten_glMultiTexCoord2iv");
    abort(-1)
}

function _emscripten_glMultiTexCoord2s() {
    err("missing function: emscripten_glMultiTexCoord2s");
    abort(-1)
}

function _emscripten_glMultiTexCoord2sv() {
    err("missing function: emscripten_glMultiTexCoord2sv");
    abort(-1)
}

function _emscripten_glMultiTexCoord3d() {
    err("missing function: emscripten_glMultiTexCoord3d");
    abort(-1)
}

function _emscripten_glMultiTexCoord3dv() {
    err("missing function: emscripten_glMultiTexCoord3dv");
    abort(-1)
}

function _emscripten_glMultiTexCoord3f() {
    err("missing function: emscripten_glMultiTexCoord3f");
    abort(-1)
}

function _emscripten_glMultiTexCoord3fv() {
    err("missing function: emscripten_glMultiTexCoord3fv");
    abort(-1)
}

function _emscripten_glMultiTexCoord3i() {
    err("missing function: emscripten_glMultiTexCoord3i");
    abort(-1)
}

function _emscripten_glMultiTexCoord3iv() {
    err("missing function: emscripten_glMultiTexCoord3iv");
    abort(-1)
}

function _emscripten_glMultiTexCoord3s() {
    err("missing function: emscripten_glMultiTexCoord3s");
    abort(-1)
}

function _emscripten_glMultiTexCoord3sv() {
    err("missing function: emscripten_glMultiTexCoord3sv");
    abort(-1)
}

function _emscripten_glMultiTexCoord4d() {
    err("missing function: emscripten_glMultiTexCoord4d");
    abort(-1)
}

function _emscripten_glMultiTexCoord4dv() {
    err("missing function: emscripten_glMultiTexCoord4dv");
    abort(-1)
}

function _emscripten_glMultiTexCoord4f() {
    err("missing function: emscripten_glMultiTexCoord4f");
    abort(-1)
}

function _emscripten_glMultiTexCoord4fv() {
    err("missing function: emscripten_glMultiTexCoord4fv");
    abort(-1)
}

function _emscripten_glMultiTexCoord4i() {
    err("missing function: emscripten_glMultiTexCoord4i");
    abort(-1)
}

function _emscripten_glMultiTexCoord4iv() {
    err("missing function: emscripten_glMultiTexCoord4iv");
    abort(-1)
}

function _emscripten_glMultiTexCoord4s() {
    err("missing function: emscripten_glMultiTexCoord4s");
    abort(-1)
}

function _emscripten_glMultiTexCoord4sv() {
    err("missing function: emscripten_glMultiTexCoord4sv");
    abort(-1)
}

function _emscripten_glNewList() {
    err("missing function: emscripten_glNewList");
    abort(-1)
}

function _emscripten_glNormal3b() {
    err("missing function: emscripten_glNormal3b");
    abort(-1)
}

function _emscripten_glNormal3bv() {
    err("missing function: emscripten_glNormal3bv");
    abort(-1)
}

function _emscripten_glNormal3d() {
    err("missing function: emscripten_glNormal3d");
    abort(-1)
}

function _emscripten_glNormal3dv() {
    err("missing function: emscripten_glNormal3dv");
    abort(-1)
}

function _emscripten_glNormal3f() {
    err("missing function: emscripten_glNormal3f");
    abort(-1)
}

function _emscripten_glNormal3fv() {
    err("missing function: emscripten_glNormal3fv");
    abort(-1)
}

function _emscripten_glNormal3i() {
    err("missing function: emscripten_glNormal3i");
    abort(-1)
}

function _emscripten_glNormal3iv() {
    err("missing function: emscripten_glNormal3iv");
    abort(-1)
}

function _emscripten_glNormal3s() {
    err("missing function: emscripten_glNormal3s");
    abort(-1)
}

function _emscripten_glNormal3sv() {
    err("missing function: emscripten_glNormal3sv");
    abort(-1)
}

function _emscripten_glNormalPointer() {
    err("missing function: emscripten_glNormalPointer");
    abort(-1)
}

function _emscripten_glOrtho() {
    err("missing function: emscripten_glOrtho");
    abort(-1)
}

function _emscripten_glPassThrough() {
    err("missing function: emscripten_glPassThrough");
    abort(-1)
}

function _emscripten_glPixelMapfv() {
    err("missing function: emscripten_glPixelMapfv");
    abort(-1)
}

function _emscripten_glPixelMapuiv() {
    err("missing function: emscripten_glPixelMapuiv");
    abort(-1)
}

function _emscripten_glPixelMapusv() {
    err("missing function: emscripten_glPixelMapusv");
    abort(-1)
}

function _emscripten_glPixelStoref() {
    err("missing function: emscripten_glPixelStoref");
    abort(-1)
}

function _emscripten_glPixelStorei(pname, param) {
    if (pname == 3333) { GL.packAlignment = param } else if (pname == 3317) { GL.unpackAlignment = param }
    GLctx.pixelStorei(pname, param)
}

function _emscripten_glPixelTransferf() {
    err("missing function: emscripten_glPixelTransferf");
    abort(-1)
}

function _emscripten_glPixelTransferi() {
    err("missing function: emscripten_glPixelTransferi");
    abort(-1)
}

function _emscripten_glPixelZoom() {
    err("missing function: emscripten_glPixelZoom");
    abort(-1)
}

function _emscripten_glPointParameterf() {
    err("missing function: emscripten_glPointParameterf");
    abort(-1)
}

function _emscripten_glPointParameterfv() {
    err("missing function: emscripten_glPointParameterfv");
    abort(-1)
}

function _emscripten_glPointParameteri() {
    err("missing function: emscripten_glPointParameteri");
    abort(-1)
}

function _emscripten_glPointParameteriv() {
    err("missing function: emscripten_glPointParameteriv");
    abort(-1)
}

function _emscripten_glPointSize() {
    err("missing function: emscripten_glPointSize");
    abort(-1)
}

function _emscripten_glPolygonMode() {
    err("missing function: emscripten_glPolygonMode");
    abort(-1)
}

function _emscripten_glPolygonOffset(x0, x1) { GLctx["polygonOffset"](x0, x1) }

function _emscripten_glPolygonStipple() {
    err("missing function: emscripten_glPolygonStipple");
    abort(-1)
}

function _emscripten_glPopAttrib() {
    err("missing function: emscripten_glPopAttrib");
    abort(-1)
}

function _emscripten_glPopClientAttrib() {
    err("missing function: emscripten_glPopClientAttrib");
    abort(-1)
}

function _emscripten_glPopMatrix() {
    err("missing function: emscripten_glPopMatrix");
    abort(-1)
}

function _emscripten_glPopName() {
    err("missing function: emscripten_glPopName");
    abort(-1)
}

function _emscripten_glPrimitiveRestartIndex() {
    err("missing function: emscripten_glPrimitiveRestartIndex");
    abort(-1)
}

function _emscripten_glPrioritizeTextures() {
    err("missing function: emscripten_glPrioritizeTextures");
    abort(-1)
}

function _emscripten_glProgramEnvParameter4dARB() {
    err("missing function: emscripten_glProgramEnvParameter4dARB");
    abort(-1)
}

function _emscripten_glProgramEnvParameter4dvARB() {
    err("missing function: emscripten_glProgramEnvParameter4dvARB");
    abort(-1)
}

function _emscripten_glProgramEnvParameter4fARB() {
    err("missing function: emscripten_glProgramEnvParameter4fARB");
    abort(-1)
}

function _emscripten_glProgramEnvParameter4fvARB() {
    err("missing function: emscripten_glProgramEnvParameter4fvARB");
    abort(-1)
}

function _emscripten_glProgramLocalParameter4dARB() {
    err("missing function: emscripten_glProgramLocalParameter4dARB");
    abort(-1)
}

function _emscripten_glProgramLocalParameter4dvARB() {
    err("missing function: emscripten_glProgramLocalParameter4dvARB");
    abort(-1)
}

function _emscripten_glProgramLocalParameter4fARB() {
    err("missing function: emscripten_glProgramLocalParameter4fARB");
    abort(-1)
}

function _emscripten_glProgramLocalParameter4fvARB() {
    err("missing function: emscripten_glProgramLocalParameter4fvARB");
    abort(-1)
}

function _emscripten_glProgramStringARB() {
    err("missing function: emscripten_glProgramStringARB");
    abort(-1)
}

function _emscripten_glPushAttrib() {
    err("missing function: emscripten_glPushAttrib");
    abort(-1)
}

function _emscripten_glPushClientAttrib() {
    err("missing function: emscripten_glPushClientAttrib");
    abort(-1)
}

function _emscripten_glPushMatrix() {
    err("missing function: emscripten_glPushMatrix");
    abort(-1)
}

function _emscripten_glPushName() {
    err("missing function: emscripten_glPushName");
    abort(-1)
}

function _emscripten_glRasterPos2d() {
    err("missing function: emscripten_glRasterPos2d");
    abort(-1)
}

function _emscripten_glRasterPos2dv() {
    err("missing function: emscripten_glRasterPos2dv");
    abort(-1)
}

function _emscripten_glRasterPos2f() {
    err("missing function: emscripten_glRasterPos2f");
    abort(-1)
}

function _emscripten_glRasterPos2fv() {
    err("missing function: emscripten_glRasterPos2fv");
    abort(-1)
}

function _emscripten_glRasterPos2i() {
    err("missing function: emscripten_glRasterPos2i");
    abort(-1)
}

function _emscripten_glRasterPos2iv() {
    err("missing function: emscripten_glRasterPos2iv");
    abort(-1)
}

function _emscripten_glRasterPos2s() {
    err("missing function: emscripten_glRasterPos2s");
    abort(-1)
}

function _emscripten_glRasterPos2sv() {
    err("missing function: emscripten_glRasterPos2sv");
    abort(-1)
}

function _emscripten_glRasterPos3d() {
    err("missing function: emscripten_glRasterPos3d");
    abort(-1)
}

function _emscripten_glRasterPos3dv() {
    err("missing function: emscripten_glRasterPos3dv");
    abort(-1)
}

function _emscripten_glRasterPos3f() {
    err("missing function: emscripten_glRasterPos3f");
    abort(-1)
}

function _emscripten_glRasterPos3fv() {
    err("missing function: emscripten_glRasterPos3fv");
    abort(-1)
}

function _emscripten_glRasterPos3i() {
    err("missing function: emscripten_glRasterPos3i");
    abort(-1)
}

function _emscripten_glRasterPos3iv() {
    err("missing function: emscripten_glRasterPos3iv");
    abort(-1)
}

function _emscripten_glRasterPos3s() {
    err("missing function: emscripten_glRasterPos3s");
    abort(-1)
}

function _emscripten_glRasterPos3sv() {
    err("missing function: emscripten_glRasterPos3sv");
    abort(-1)
}

function _emscripten_glRasterPos4d() {
    err("missing function: emscripten_glRasterPos4d");
    abort(-1)
}

function _emscripten_glRasterPos4dv() {
    err("missing function: emscripten_glRasterPos4dv");
    abort(-1)
}

function _emscripten_glRasterPos4f() {
    err("missing function: emscripten_glRasterPos4f");
    abort(-1)
}

function _emscripten_glRasterPos4fv() {
    err("missing function: emscripten_glRasterPos4fv");
    abort(-1)
}

function _emscripten_glRasterPos4i() {
    err("missing function: emscripten_glRasterPos4i");
    abort(-1)
}

function _emscripten_glRasterPos4iv() {
    err("missing function: emscripten_glRasterPos4iv");
    abort(-1)
}

function _emscripten_glRasterPos4s() {
    err("missing function: emscripten_glRasterPos4s");
    abort(-1)
}

function _emscripten_glRasterPos4sv() {
    err("missing function: emscripten_glRasterPos4sv");
    abort(-1)
}

function _emscripten_glReadBuffer() {
    err("missing function: emscripten_glReadBuffer");
    abort(-1)
}

function emscriptenWebGLComputeImageSize(width, height, sizePerPixel, alignment) {
    function roundedToNextMultipleOf(x, y) { return Math.floor((x + y - 1) / y) * y }
    var plainRowSize = width * sizePerPixel;
    var alignedRowSize = roundedToNextMultipleOf(plainRowSize, alignment);
    return height <= 0 ? 0 : (height - 1) * alignedRowSize + plainRowSize
}

function emscriptenWebGLGetTexPixelData(type, format, width, height, pixels, internalFormat) {
    var sizePerPixel;
    var numChannels;
    switch (format) {
        case 6406:
        case 6409:
        case 6402:
            numChannels = 1;
            break;
        case 6410:
            numChannels = 2;
            break;
        case 6407:
        case 35904:
            numChannels = 3;
            break;
        case 6408:
        case 35906:
            numChannels = 4;
            break;
        default:
            GL.recordError(1280);
            return null
    }
    switch (type) {
        case 5121:
            sizePerPixel = numChannels * 1;
            break;
        case 5123:
        case 36193:
            sizePerPixel = numChannels * 2;
            break;
        case 5125:
        case 5126:
            sizePerPixel = numChannels * 4;
            break;
        case 34042:
            sizePerPixel = 4;
            break;
        case 33635:
        case 32819:
        case 32820:
            sizePerPixel = 2;
            break;
        default:
            GL.recordError(1280);
            return null
    }
    var bytes = emscriptenWebGLComputeImageSize(width, height, sizePerPixel, GL.unpackAlignment);
    switch (type) {
        case 5121:
            return HEAPU8.subarray(pixels, pixels + bytes);
        case 5126:
            return HEAPF32.subarray(pixels >> 2, pixels + bytes >> 2);
        case 5125:
        case 34042:
            return HEAPU32.subarray(pixels >> 2, pixels + bytes >> 2);
        case 5123:
        case 33635:
        case 32819:
        case 32820:
        case 36193:
            return HEAPU16.subarray(pixels >> 1, pixels + bytes >> 1);
        default:
            GL.recordError(1280);
            return null
    }
}

function _emscripten_glReadPixels(x, y, width, height, format, type, pixels) {
    var pixelData = emscriptenWebGLGetTexPixelData(type, format, width, height, pixels, format);
    if (!pixelData) { GL.recordError(1280); return }
    GLctx.readPixels(x, y, width, height, format, type, pixelData)
}

function _emscripten_glRectd() {
    err("missing function: emscripten_glRectd");
    abort(-1)
}

function _emscripten_glRectdv() {
    err("missing function: emscripten_glRectdv");
    abort(-1)
}

function _emscripten_glRectf() {
    err("missing function: emscripten_glRectf");
    abort(-1)
}

function _emscripten_glRectfv() {
    err("missing function: emscripten_glRectfv");
    abort(-1)
}

function _emscripten_glRecti() {
    err("missing function: emscripten_glRecti");
    abort(-1)
}

function _emscripten_glRectiv() {
    err("missing function: emscripten_glRectiv");
    abort(-1)
}

function _emscripten_glRects() {
    err("missing function: emscripten_glRects");
    abort(-1)
}

function _emscripten_glRectsv() {
    err("missing function: emscripten_glRectsv");
    abort(-1)
}

function _emscripten_glReleaseShaderCompiler() {}

function _emscripten_glRenderMode() {
    err("missing function: emscripten_glRenderMode");
    abort(-1)
}

function _emscripten_glRenderbufferStorage(x0, x1, x2, x3) { GLctx["renderbufferStorage"](x0, x1, x2, x3) }

function _emscripten_glRenderbufferStorageMultisample() {
    err("missing function: emscripten_glRenderbufferStorageMultisample");
    abort(-1)
}

function _emscripten_glResetHistogram() {
    err("missing function: emscripten_glResetHistogram");
    abort(-1)
}

function _emscripten_glResetMinmax() {
    err("missing function: emscripten_glResetMinmax");
    abort(-1)
}

function _emscripten_glRotated() {
    err("missing function: emscripten_glRotated");
    abort(-1)
}

function _emscripten_glRotatef() {
    err("missing function: emscripten_glRotatef");
    abort(-1)
}

function _emscripten_glSampleCoverage(value, invert) { GLctx.sampleCoverage(value, !!invert) }

function _emscripten_glScaled() {
    err("missing function: emscripten_glScaled");
    abort(-1)
}

function _emscripten_glScalef() {
    err("missing function: emscripten_glScalef");
    abort(-1)
}

function _emscripten_glScissor(x0, x1, x2, x3) { GLctx["scissor"](x0, x1, x2, x3) }

function _emscripten_glSecondaryColor3b() {
    err("missing function: emscripten_glSecondaryColor3b");
    abort(-1)
}

function _emscripten_glSecondaryColor3bv() {
    err("missing function: emscripten_glSecondaryColor3bv");
    abort(-1)
}

function _emscripten_glSecondaryColor3d() {
    err("missing function: emscripten_glSecondaryColor3d");
    abort(-1)
}

function _emscripten_glSecondaryColor3dv() {
    err("missing function: emscripten_glSecondaryColor3dv");
    abort(-1)
}

function _emscripten_glSecondaryColor3f() {
    err("missing function: emscripten_glSecondaryColor3f");
    abort(-1)
}

function _emscripten_glSecondaryColor3fv() {
    err("missing function: emscripten_glSecondaryColor3fv");
    abort(-1)
}

function _emscripten_glSecondaryColor3i() {
    err("missing function: emscripten_glSecondaryColor3i");
    abort(-1)
}

function _emscripten_glSecondaryColor3iv() {
    err("missing function: emscripten_glSecondaryColor3iv");
    abort(-1)
}

function _emscripten_glSecondaryColor3s() {
    err("missing function: emscripten_glSecondaryColor3s");
    abort(-1)
}

function _emscripten_glSecondaryColor3sv() {
    err("missing function: emscripten_glSecondaryColor3sv");
    abort(-1)
}

function _emscripten_glSecondaryColor3ub() {
    err("missing function: emscripten_glSecondaryColor3ub");
    abort(-1)
}

function _emscripten_glSecondaryColor3ubv() {
    err("missing function: emscripten_glSecondaryColor3ubv");
    abort(-1)
}

function _emscripten_glSecondaryColor3ui() {
    err("missing function: emscripten_glSecondaryColor3ui");
    abort(-1)
}

function _emscripten_glSecondaryColor3uiv() {
    err("missing function: emscripten_glSecondaryColor3uiv");
    abort(-1)
}

function _emscripten_glSecondaryColor3us() {
    err("missing function: emscripten_glSecondaryColor3us");
    abort(-1)
}

function _emscripten_glSecondaryColor3usv() {
    err("missing function: emscripten_glSecondaryColor3usv");
    abort(-1)
}

function _emscripten_glSecondaryColorPointer() {
    err("missing function: emscripten_glSecondaryColorPointer");
    abort(-1)
}

function _emscripten_glSelectBuffer() {
    err("missing function: emscripten_glSelectBuffer");
    abort(-1)
}

function _emscripten_glSeparableFilter2D() {
    err("missing function: emscripten_glSeparableFilter2D");
    abort(-1)
}

function _emscripten_glShadeModel() {
    err("missing function: emscripten_glShadeModel");
    abort(-1)
}

function _emscripten_glShaderBinary() { GL.recordError(1280) }

function _emscripten_glShaderSource(shader, count, string, length) {
    var source = GL.getSource(shader, count, string, length);
    GLctx.shaderSource(GL.shaders[shader], source)
}

function _emscripten_glStencilFunc(x0, x1, x2) { GLctx["stencilFunc"](x0, x1, x2) }

function _emscripten_glStencilFuncSeparate(x0, x1, x2, x3) { GLctx["stencilFuncSeparate"](x0, x1, x2, x3) }

function _emscripten_glStencilMask(x0) { GLctx["stencilMask"](x0) }

function _emscripten_glStencilMaskSeparate(x0, x1) { GLctx["stencilMaskSeparate"](x0, x1) }

function _emscripten_glStencilOp(x0, x1, x2) { GLctx["stencilOp"](x0, x1, x2) }

function _emscripten_glStencilOpSeparate(x0, x1, x2, x3) { GLctx["stencilOpSeparate"](x0, x1, x2, x3) }

function _emscripten_glTexBuffer() {
    err("missing function: emscripten_glTexBuffer");
    abort(-1)
}

function _emscripten_glTexCoord1d() {
    err("missing function: emscripten_glTexCoord1d");
    abort(-1)
}

function _emscripten_glTexCoord1dv() {
    err("missing function: emscripten_glTexCoord1dv");
    abort(-1)
}

function _emscripten_glTexCoord1f() {
    err("missing function: emscripten_glTexCoord1f");
    abort(-1)
}

function _emscripten_glTexCoord1fv() {
    err("missing function: emscripten_glTexCoord1fv");
    abort(-1)
}

function _emscripten_glTexCoord1i() {
    err("missing function: emscripten_glTexCoord1i");
    abort(-1)
}

function _emscripten_glTexCoord1iv() {
    err("missing function: emscripten_glTexCoord1iv");
    abort(-1)
}

function _emscripten_glTexCoord1s() {
    err("missing function: emscripten_glTexCoord1s");
    abort(-1)
}

function _emscripten_glTexCoord1sv() {
    err("missing function: emscripten_glTexCoord1sv");
    abort(-1)
}

function _emscripten_glTexCoord2d() {
    err("missing function: emscripten_glTexCoord2d");
    abort(-1)
}

function _emscripten_glTexCoord2dv() {
    err("missing function: emscripten_glTexCoord2dv");
    abort(-1)
}

function _emscripten_glTexCoord2f() {
    err("missing function: emscripten_glTexCoord2f");
    abort(-1)
}

function _emscripten_glTexCoord2fv() {
    err("missing function: emscripten_glTexCoord2fv");
    abort(-1)
}

function _emscripten_glTexCoord2i() {
    err("missing function: emscripten_glTexCoord2i");
    abort(-1)
}

function _emscripten_glTexCoord2iv() {
    err("missing function: emscripten_glTexCoord2iv");
    abort(-1)
}

function _emscripten_glTexCoord2s() {
    err("missing function: emscripten_glTexCoord2s");
    abort(-1)
}

function _emscripten_glTexCoord2sv() {
    err("missing function: emscripten_glTexCoord2sv");
    abort(-1)
}

function _emscripten_glTexCoord3d() {
    err("missing function: emscripten_glTexCoord3d");
    abort(-1)
}

function _emscripten_glTexCoord3dv() {
    err("missing function: emscripten_glTexCoord3dv");
    abort(-1)
}

function _emscripten_glTexCoord3f() {
    err("missing function: emscripten_glTexCoord3f");
    abort(-1)
}

function _emscripten_glTexCoord3fv() {
    err("missing function: emscripten_glTexCoord3fv");
    abort(-1)
}

function _emscripten_glTexCoord3i() {
    err("missing function: emscripten_glTexCoord3i");
    abort(-1)
}

function _emscripten_glTexCoord3iv() {
    err("missing function: emscripten_glTexCoord3iv");
    abort(-1)
}

function _emscripten_glTexCoord3s() {
    err("missing function: emscripten_glTexCoord3s");
    abort(-1)
}

function _emscripten_glTexCoord3sv() {
    err("missing function: emscripten_glTexCoord3sv");
    abort(-1)
}

function _emscripten_glTexCoord4d() {
    err("missing function: emscripten_glTexCoord4d");
    abort(-1)
}

function _emscripten_glTexCoord4dv() {
    err("missing function: emscripten_glTexCoord4dv");
    abort(-1)
}

function _emscripten_glTexCoord4f() {
    err("missing function: emscripten_glTexCoord4f");
    abort(-1)
}

function _emscripten_glTexCoord4fv() {
    err("missing function: emscripten_glTexCoord4fv");
    abort(-1)
}

function _emscripten_glTexCoord4i() {
    err("missing function: emscripten_glTexCoord4i");
    abort(-1)
}

function _emscripten_glTexCoord4iv() {
    err("missing function: emscripten_glTexCoord4iv");
    abort(-1)
}

function _emscripten_glTexCoord4s() {
    err("missing function: emscripten_glTexCoord4s");
    abort(-1)
}

function _emscripten_glTexCoord4sv() {
    err("missing function: emscripten_glTexCoord4sv");
    abort(-1)
}

function _emscripten_glTexCoordPointer() {
    err("missing function: emscripten_glTexCoordPointer");
    abort(-1)
}

function _emscripten_glTexEnvf() {
    err("missing function: emscripten_glTexEnvf");
    abort(-1)
}

function _emscripten_glTexEnvfv() {
    err("missing function: emscripten_glTexEnvfv");
    abort(-1)
}

function _emscripten_glTexEnvi() {
    err("missing function: emscripten_glTexEnvi");
    abort(-1)
}

function _emscripten_glTexEnviv() {
    err("missing function: emscripten_glTexEnviv");
    abort(-1)
}

function _emscripten_glTexGend() {
    err("missing function: emscripten_glTexGend");
    abort(-1)
}

function _emscripten_glTexGendv() {
    err("missing function: emscripten_glTexGendv");
    abort(-1)
}

function _emscripten_glTexGenf() {
    err("missing function: emscripten_glTexGenf");
    abort(-1)
}

function _emscripten_glTexGenfv() {
    err("missing function: emscripten_glTexGenfv");
    abort(-1)
}

function _emscripten_glTexGeni() {
    err("missing function: emscripten_glTexGeni");
    abort(-1)
}

function _emscripten_glTexGeniv() {
    err("missing function: emscripten_glTexGeniv");
    abort(-1)
}

function _emscripten_glTexImage1D() {
    err("missing function: emscripten_glTexImage1D");
    abort(-1)
}

function _emscripten_glTexImage2D(target, level, internalFormat, width, height, border, format, type, pixels) {
    var pixelData = null;
    if (pixels) pixelData = emscriptenWebGLGetTexPixelData(type, format, width, height, pixels, internalFormat);
    GLctx.texImage2D(target, level, internalFormat, width, height, border, format, type, pixelData)
}

function _emscripten_glTexImage3D() {
    err("missing function: emscripten_glTexImage3D");
    abort(-1)
}

function _emscripten_glTexParameterIiv() {
    err("missing function: emscripten_glTexParameterIiv");
    abort(-1)
}

function _emscripten_glTexParameterIuiv() {
    err("missing function: emscripten_glTexParameterIuiv");
    abort(-1)
}

function _emscripten_glTexParameterf(x0, x1, x2) { GLctx["texParameterf"](x0, x1, x2) }

function _emscripten_glTexParameterfv(target, pname, params) {
    var param = HEAPF32[params >> 2];
    GLctx.texParameterf(target, pname, param)
}

function _emscripten_glTexParameteri(x0, x1, x2) { GLctx["texParameteri"](x0, x1, x2) }

function _emscripten_glTexParameteriv(target, pname, params) {
    var param = HEAP32[params >> 2];
    GLctx.texParameteri(target, pname, param)
}

function _emscripten_glTexStorage2D() {
    err("missing function: emscripten_glTexStorage2D");
    abort(-1)
}

function _emscripten_glTexStorage3D() {
    err("missing function: emscripten_glTexStorage3D");
    abort(-1)
}

function _emscripten_glTexSubImage1D() {
    err("missing function: emscripten_glTexSubImage1D");
    abort(-1)
}

function _emscripten_glTexSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixels) {
    var pixelData = null;
    if (pixels) pixelData = emscriptenWebGLGetTexPixelData(type, format, width, height, pixels, 0);
    GLctx.texSubImage2D(target, level, xoffset, yoffset, width, height, format, type, pixelData)
}

function _emscripten_glTexSubImage3D() {
    err("missing function: emscripten_glTexSubImage3D");
    abort(-1)
}

function _emscripten_glTransformFeedbackVaryings() {
    err("missing function: emscripten_glTransformFeedbackVaryings");
    abort(-1)
}

function _emscripten_glTranslated() {
    err("missing function: emscripten_glTranslated");
    abort(-1)
}

function _emscripten_glTranslatef() {
    err("missing function: emscripten_glTranslatef");
    abort(-1)
}

function _emscripten_glUniform1f(location, v0) { GLctx.uniform1f(GL.uniforms[location], v0) }

function _emscripten_glUniform1fv(location, count, value) {
    var view;
    if (count <= GL.MINI_TEMP_BUFFER_SIZE) { view = GL.miniTempBufferViews[count - 1]; for (var i = 0; i < count; ++i) { view[i] = HEAPF32[value + 4 * i >> 2] } } else { view = HEAPF32.subarray(value >> 2, value + count * 4 >> 2) }
    GLctx.uniform1fv(GL.uniforms[location], view)
}

function _emscripten_glUniform1i(location, v0) { GLctx.uniform1i(GL.uniforms[location], v0) }

function _emscripten_glUniform1iv(location, count, value) { GLctx.uniform1iv(GL.uniforms[location], HEAP32.subarray(value >> 2, value + count * 4 >> 2)) }

function _emscripten_glUniform1ui() {
    err("missing function: emscripten_glUniform1ui");
    abort(-1)
}

function _emscripten_glUniform1uiv() {
    err("missing function: emscripten_glUniform1uiv");
    abort(-1)
}

function _emscripten_glUniform2f(location, v0, v1) { GLctx.uniform2f(GL.uniforms[location], v0, v1) }

function _emscripten_glUniform2fv(location, count, value) {
    var view;
    if (2 * count <= GL.MINI_TEMP_BUFFER_SIZE) {
        view = GL.miniTempBufferViews[2 * count - 1];
        for (var i = 0; i < 2 * count; i += 2) {
            view[i] = HEAPF32[value + 4 * i >> 2];
            view[i + 1] = HEAPF32[value + (4 * i + 4) >> 2]
        }
    } else { view = HEAPF32.subarray(value >> 2, value + count * 8 >> 2) }
    GLctx.uniform2fv(GL.uniforms[location], view)
}

function _emscripten_glUniform2i(location, v0, v1) { GLctx.uniform2i(GL.uniforms[location], v0, v1) }

function _emscripten_glUniform2iv(location, count, value) { GLctx.uniform2iv(GL.uniforms[location], HEAP32.subarray(value >> 2, value + count * 8 >> 2)) }

function _emscripten_glUniform2ui() {
    err("missing function: emscripten_glUniform2ui");
    abort(-1)
}

function _emscripten_glUniform2uiv() {
    err("missing function: emscripten_glUniform2uiv");
    abort(-1)
}

function _emscripten_glUniform3f(location, v0, v1, v2) { GLctx.uniform3f(GL.uniforms[location], v0, v1, v2) }

function _emscripten_glUniform3fv(location, count, value) {
    var view;
    if (3 * count <= GL.MINI_TEMP_BUFFER_SIZE) {
        view = GL.miniTempBufferViews[3 * count - 1];
        for (var i = 0; i < 3 * count; i += 3) {
            view[i] = HEAPF32[value + 4 * i >> 2];
            view[i + 1] = HEAPF32[value + (4 * i + 4) >> 2];
            view[i + 2] = HEAPF32[value + (4 * i + 8) >> 2]
        }
    } else { view = HEAPF32.subarray(value >> 2, value + count * 12 >> 2) }
    GLctx.uniform3fv(GL.uniforms[location], view)
}

function _emscripten_glUniform3i(location, v0, v1, v2) { GLctx.uniform3i(GL.uniforms[location], v0, v1, v2) }

function _emscripten_glUniform3iv(location, count, value) { GLctx.uniform3iv(GL.uniforms[location], HEAP32.subarray(value >> 2, value + count * 12 >> 2)) }

function _emscripten_glUniform3ui() {
    err("missing function: emscripten_glUniform3ui");
    abort(-1)
}

function _emscripten_glUniform3uiv() {
    err("missing function: emscripten_glUniform3uiv");
    abort(-1)
}

function _emscripten_glUniform4f(location, v0, v1, v2, v3) { GLctx.uniform4f(GL.uniforms[location], v0, v1, v2, v3) }

function _emscripten_glUniform4fv(location, count, value) {
    var view;
    if (4 * count <= GL.MINI_TEMP_BUFFER_SIZE) {
        view = GL.miniTempBufferViews[4 * count - 1];
        for (var i = 0; i < 4 * count; i += 4) {
            view[i] = HEAPF32[value + 4 * i >> 2];
            view[i + 1] = HEAPF32[value + (4 * i + 4) >> 2];
            view[i + 2] = HEAPF32[value + (4 * i + 8) >> 2];
            view[i + 3] = HEAPF32[value + (4 * i + 12) >> 2]
        }
    } else { view = HEAPF32.subarray(value >> 2, value + count * 16 >> 2) }
    GLctx.uniform4fv(GL.uniforms[location], view)
}

function _emscripten_glUniform4i(location, v0, v1, v2, v3) { GLctx.uniform4i(GL.uniforms[location], v0, v1, v2, v3) }

function _emscripten_glUniform4iv(location, count, value) { GLctx.uniform4iv(GL.uniforms[location], HEAP32.subarray(value >> 2, value + count * 16 >> 2)) }

function _emscripten_glUniform4ui() {
    err("missing function: emscripten_glUniform4ui");
    abort(-1)
}

function _emscripten_glUniform4uiv() {
    err("missing function: emscripten_glUniform4uiv");
    abort(-1)
}

function _emscripten_glUniformBlockBinding() {
    err("missing function: emscripten_glUniformBlockBinding");
    abort(-1)
}

function _emscripten_glUniformMatrix2fv(location, count, transpose, value) {
    var view;
    if (4 * count <= GL.MINI_TEMP_BUFFER_SIZE) {
        view = GL.miniTempBufferViews[4 * count - 1];
        for (var i = 0; i < 4 * count; i += 4) {
            view[i] = HEAPF32[value + 4 * i >> 2];
            view[i + 1] = HEAPF32[value + (4 * i + 4) >> 2];
            view[i + 2] = HEAPF32[value + (4 * i + 8) >> 2];
            view[i + 3] = HEAPF32[value + (4 * i + 12) >> 2]
        }
    } else { view = HEAPF32.subarray(value >> 2, value + count * 16 >> 2) }
    GLctx.uniformMatrix2fv(GL.uniforms[location], !!transpose, view)
}

function _emscripten_glUniformMatrix2x3fv() {
    err("missing function: emscripten_glUniformMatrix2x3fv");
    abort(-1)
}

function _emscripten_glUniformMatrix2x4fv() {
    err("missing function: emscripten_glUniformMatrix2x4fv");
    abort(-1)
}

function _emscripten_glUniformMatrix3fv(location, count, transpose, value) {
    var view;
    if (9 * count <= GL.MINI_TEMP_BUFFER_SIZE) {
        view = GL.miniTempBufferViews[9 * count - 1];
        for (var i = 0; i < 9 * count; i += 9) {
            view[i] = HEAPF32[value + 4 * i >> 2];
            view[i + 1] = HEAPF32[value + (4 * i + 4) >> 2];
            view[i + 2] = HEAPF32[value + (4 * i + 8) >> 2];
            view[i + 3] = HEAPF32[value + (4 * i + 12) >> 2];
            view[i + 4] = HEAPF32[value + (4 * i + 16) >> 2];
            view[i + 5] = HEAPF32[value + (4 * i + 20) >> 2];
            view[i + 6] = HEAPF32[value + (4 * i + 24) >> 2];
            view[i + 7] = HEAPF32[value + (4 * i + 28) >> 2];
            view[i + 8] = HEAPF32[value + (4 * i + 32) >> 2]
        }
    } else { view = HEAPF32.subarray(value >> 2, value + count * 36 >> 2) }
    GLctx.uniformMatrix3fv(GL.uniforms[location], !!transpose, view)
}

function _emscripten_glUniformMatrix3x2fv() {
    err("missing function: emscripten_glUniformMatrix3x2fv");
    abort(-1)
}

function _emscripten_glUniformMatrix3x4fv() {
    err("missing function: emscripten_glUniformMatrix3x4fv");
    abort(-1)
}

function _emscripten_glUniformMatrix4fv(location, count, transpose, value) {
    var view;
    if (16 * count <= GL.MINI_TEMP_BUFFER_SIZE) {
        view = GL.miniTempBufferViews[16 * count - 1];
        for (var i = 0; i < 16 * count; i += 16) {
            view[i] = HEAPF32[value + 4 * i >> 2];
            view[i + 1] = HEAPF32[value + (4 * i + 4) >> 2];
            view[i + 2] = HEAPF32[value + (4 * i + 8) >> 2];
            view[i + 3] = HEAPF32[value + (4 * i + 12) >> 2];
            view[i + 4] = HEAPF32[value + (4 * i + 16) >> 2];
            view[i + 5] = HEAPF32[value + (4 * i + 20) >> 2];
            view[i + 6] = HEAPF32[value + (4 * i + 24) >> 2];
            view[i + 7] = HEAPF32[value + (4 * i + 28) >> 2];
            view[i + 8] = HEAPF32[value + (4 * i + 32) >> 2];
            view[i + 9] = HEAPF32[value + (4 * i + 36) >> 2];
            view[i + 10] = HEAPF32[value + (4 * i + 40) >> 2];
            view[i + 11] = HEAPF32[value + (4 * i + 44) >> 2];
            view[i + 12] = HEAPF32[value + (4 * i + 48) >> 2];
            view[i + 13] = HEAPF32[value + (4 * i + 52) >> 2];
            view[i + 14] = HEAPF32[value + (4 * i + 56) >> 2];
            view[i + 15] = HEAPF32[value + (4 * i + 60) >> 2]
        }
    } else { view = HEAPF32.subarray(value >> 2, value + count * 64 >> 2) }
    GLctx.uniformMatrix4fv(GL.uniforms[location], !!transpose, view)
}

function _emscripten_glUniformMatrix4x2fv() {
    err("missing function: emscripten_glUniformMatrix4x2fv");
    abort(-1)
}

function _emscripten_glUniformMatrix4x3fv() {
    err("missing function: emscripten_glUniformMatrix4x3fv");
    abort(-1)
}

function _emscripten_glUnmapBuffer() {
    err("missing function: emscripten_glUnmapBuffer");
    abort(-1)
}

function _emscripten_glUseProgram(program) { GLctx.useProgram(program ? GL.programs[program] : null) }

function _emscripten_glUseProgramObjectARB() {
    err("missing function: emscripten_glUseProgramObjectARB");
    abort(-1)
}

function _emscripten_glValidateProgram(program) { GLctx.validateProgram(GL.programs[program]) }

function _emscripten_glVertex2d() {
    err("missing function: emscripten_glVertex2d");
    abort(-1)
}

function _emscripten_glVertex2dv() {
    err("missing function: emscripten_glVertex2dv");
    abort(-1)
}

function _emscripten_glVertex2f() {
    err("missing function: emscripten_glVertex2f");
    abort(-1)
}

function _emscripten_glVertex2fv() {
    err("missing function: emscripten_glVertex2fv");
    abort(-1)
}

function _emscripten_glVertex2i() {
    err("missing function: emscripten_glVertex2i");
    abort(-1)
}

function _emscripten_glVertex2iv() {
    err("missing function: emscripten_glVertex2iv");
    abort(-1)
}

function _emscripten_glVertex2s() {
    err("missing function: emscripten_glVertex2s");
    abort(-1)
}

function _emscripten_glVertex2sv() {
    err("missing function: emscripten_glVertex2sv");
    abort(-1)
}

function _emscripten_glVertex3d() {
    err("missing function: emscripten_glVertex3d");
    abort(-1)
}

function _emscripten_glVertex3dv() {
    err("missing function: emscripten_glVertex3dv");
    abort(-1)
}

function _emscripten_glVertex3f() {
    err("missing function: emscripten_glVertex3f");
    abort(-1)
}

function _emscripten_glVertex3fv() {
    err("missing function: emscripten_glVertex3fv");
    abort(-1)
}

function _emscripten_glVertex3i() {
    err("missing function: emscripten_glVertex3i");
    abort(-1)
}

function _emscripten_glVertex3iv() {
    err("missing function: emscripten_glVertex3iv");
    abort(-1)
}

function _emscripten_glVertex3s() {
    err("missing function: emscripten_glVertex3s");
    abort(-1)
}

function _emscripten_glVertex3sv() {
    err("missing function: emscripten_glVertex3sv");
    abort(-1)
}

function _emscripten_glVertex4d() {
    err("missing function: emscripten_glVertex4d");
    abort(-1)
}

function _emscripten_glVertex4dv() {
    err("missing function: emscripten_glVertex4dv");
    abort(-1)
}

function _emscripten_glVertex4f() {
    err("missing function: emscripten_glVertex4f");
    abort(-1)
}

function _emscripten_glVertex4fv() {
    err("missing function: emscripten_glVertex4fv");
    abort(-1)
}

function _emscripten_glVertex4i() {
    err("missing function: emscripten_glVertex4i");
    abort(-1)
}

function _emscripten_glVertex4iv() {
    err("missing function: emscripten_glVertex4iv");
    abort(-1)
}

function _emscripten_glVertex4s() {
    err("missing function: emscripten_glVertex4s");
    abort(-1)
}

function _emscripten_glVertex4sv() {
    err("missing function: emscripten_glVertex4sv");
    abort(-1)
}

function _emscripten_glVertexAttrib1d() {
    err("missing function: emscripten_glVertexAttrib1d");
    abort(-1)
}

function _emscripten_glVertexAttrib1dv() {
    err("missing function: emscripten_glVertexAttrib1dv");
    abort(-1)
}

function _emscripten_glVertexAttrib1f(x0, x1) { GLctx["vertexAttrib1f"](x0, x1) }

function _emscripten_glVertexAttrib1fv(index, v) { GLctx.vertexAttrib1f(index, HEAPF32[v >> 2]) }

function _emscripten_glVertexAttrib1s() {
    err("missing function: emscripten_glVertexAttrib1s");
    abort(-1)
}

function _emscripten_glVertexAttrib1sv() {
    err("missing function: emscripten_glVertexAttrib1sv");
    abort(-1)
}

function _emscripten_glVertexAttrib2d() {
    err("missing function: emscripten_glVertexAttrib2d");
    abort(-1)
}

function _emscripten_glVertexAttrib2dv() {
    err("missing function: emscripten_glVertexAttrib2dv");
    abort(-1)
}

function _emscripten_glVertexAttrib2f(x0, x1, x2) { GLctx["vertexAttrib2f"](x0, x1, x2) }

function _emscripten_glVertexAttrib2fv(index, v) { GLctx.vertexAttrib2f(index, HEAPF32[v >> 2], HEAPF32[v + 4 >> 2]) }

function _emscripten_glVertexAttrib2s() {
    err("missing function: emscripten_glVertexAttrib2s");
    abort(-1)
}

function _emscripten_glVertexAttrib2sv() {
    err("missing function: emscripten_glVertexAttrib2sv");
    abort(-1)
}

function _emscripten_glVertexAttrib3d() {
    err("missing function: emscripten_glVertexAttrib3d");
    abort(-1)
}

function _emscripten_glVertexAttrib3dv() {
    err("missing function: emscripten_glVertexAttrib3dv");
    abort(-1)
}

function _emscripten_glVertexAttrib3f(x0, x1, x2, x3) { GLctx["vertexAttrib3f"](x0, x1, x2, x3) }

function _emscripten_glVertexAttrib3fv(index, v) { GLctx.vertexAttrib3f(index, HEAPF32[v >> 2], HEAPF32[v + 4 >> 2], HEAPF32[v + 8 >> 2]) }

function _emscripten_glVertexAttrib3s() {
    err("missing function: emscripten_glVertexAttrib3s");
    abort(-1)
}

function _emscripten_glVertexAttrib3sv() {
    err("missing function: emscripten_glVertexAttrib3sv");
    abort(-1)
}

function _emscripten_glVertexAttrib4Nbv() {
    err("missing function: emscripten_glVertexAttrib4Nbv");
    abort(-1)
}

function _emscripten_glVertexAttrib4Niv() {
    err("missing function: emscripten_glVertexAttrib4Niv");
    abort(-1)
}

function _emscripten_glVertexAttrib4Nsv() {
    err("missing function: emscripten_glVertexAttrib4Nsv");
    abort(-1)
}

function _emscripten_glVertexAttrib4Nub() {
    err("missing function: emscripten_glVertexAttrib4Nub");
    abort(-1)
}

function _emscripten_glVertexAttrib4Nubv() {
    err("missing function: emscripten_glVertexAttrib4Nubv");
    abort(-1)
}

function _emscripten_glVertexAttrib4Nuiv() {
    err("missing function: emscripten_glVertexAttrib4Nuiv");
    abort(-1)
}

function _emscripten_glVertexAttrib4Nusv() {
    err("missing function: emscripten_glVertexAttrib4Nusv");
    abort(-1)
}

function _emscripten_glVertexAttrib4bv() {
    err("missing function: emscripten_glVertexAttrib4bv");
    abort(-1)
}

function _emscripten_glVertexAttrib4d() {
    err("missing function: emscripten_glVertexAttrib4d");
    abort(-1)
}

function _emscripten_glVertexAttrib4dv() {
    err("missing function: emscripten_glVertexAttrib4dv");
    abort(-1)
}

function _emscripten_glVertexAttrib4f(x0, x1, x2, x3, x4) { GLctx["vertexAttrib4f"](x0, x1, x2, x3, x4) }

function _emscripten_glVertexAttrib4fv(index, v) { GLctx.vertexAttrib4f(index, HEAPF32[v >> 2], HEAPF32[v + 4 >> 2], HEAPF32[v + 8 >> 2], HEAPF32[v + 12 >> 2]) }

function _emscripten_glVertexAttrib4iv() {
    err("missing function: emscripten_glVertexAttrib4iv");
    abort(-1)
}

function _emscripten_glVertexAttrib4s() {
    err("missing function: emscripten_glVertexAttrib4s");
    abort(-1)
}

function _emscripten_glVertexAttrib4sv() {
    err("missing function: emscripten_glVertexAttrib4sv");
    abort(-1)
}

function _emscripten_glVertexAttrib4ubv() {
    err("missing function: emscripten_glVertexAttrib4ubv");
    abort(-1)
}

function _emscripten_glVertexAttrib4uiv() {
    err("missing function: emscripten_glVertexAttrib4uiv");
    abort(-1)
}

function _emscripten_glVertexAttrib4usv() {
    err("missing function: emscripten_glVertexAttrib4usv");
    abort(-1)
}

function _emscripten_glVertexAttribDivisor(index, divisor) { GLctx["vertexAttribDivisor"](index, divisor) }

function _emscripten_glVertexAttribI1i() {
    err("missing function: emscripten_glVertexAttribI1i");
    abort(-1)
}

function _emscripten_glVertexAttribI1iv() {
    err("missing function: emscripten_glVertexAttribI1iv");
    abort(-1)
}

function _emscripten_glVertexAttribI1ui() {
    err("missing function: emscripten_glVertexAttribI1ui");
    abort(-1)
}

function _emscripten_glVertexAttribI1uiv() {
    err("missing function: emscripten_glVertexAttribI1uiv");
    abort(-1)
}

function _emscripten_glVertexAttribI2i() {
    err("missing function: emscripten_glVertexAttribI2i");
    abort(-1)
}

function _emscripten_glVertexAttribI2iv() {
    err("missing function: emscripten_glVertexAttribI2iv");
    abort(-1)
}

function _emscripten_glVertexAttribI2ui() {
    err("missing function: emscripten_glVertexAttribI2ui");
    abort(-1)
}

function _emscripten_glVertexAttribI2uiv() {
    err("missing function: emscripten_glVertexAttribI2uiv");
    abort(-1)
}

function _emscripten_glVertexAttribI3i() {
    err("missing function: emscripten_glVertexAttribI3i");
    abort(-1)
}

function _emscripten_glVertexAttribI3iv() {
    err("missing function: emscripten_glVertexAttribI3iv");
    abort(-1)
}

function _emscripten_glVertexAttribI3ui() {
    err("missing function: emscripten_glVertexAttribI3ui");
    abort(-1)
}

function _emscripten_glVertexAttribI3uiv() {
    err("missing function: emscripten_glVertexAttribI3uiv");
    abort(-1)
}

function _emscripten_glVertexAttribI4bv() {
    err("missing function: emscripten_glVertexAttribI4bv");
    abort(-1)
}

function _emscripten_glVertexAttribI4i() {
    err("missing function: emscripten_glVertexAttribI4i");
    abort(-1)
}

function _emscripten_glVertexAttribI4iv() {
    err("missing function: emscripten_glVertexAttribI4iv");
    abort(-1)
}

function _emscripten_glVertexAttribI4sv() {
    err("missing function: emscripten_glVertexAttribI4sv");
    abort(-1)
}

function _emscripten_glVertexAttribI4ubv() {
    err("missing function: emscripten_glVertexAttribI4ubv");
    abort(-1)
}

function _emscripten_glVertexAttribI4ui() {
    err("missing function: emscripten_glVertexAttribI4ui");
    abort(-1)
}

function _emscripten_glVertexAttribI4uiv() {
    err("missing function: emscripten_glVertexAttribI4uiv");
    abort(-1)
}

function _emscripten_glVertexAttribI4usv() {
    err("missing function: emscripten_glVertexAttribI4usv");
    abort(-1)
}

function _emscripten_glVertexAttribIPointer() {
    err("missing function: emscripten_glVertexAttribIPointer");
    abort(-1)
}

function _emscripten_glVertexAttribPointer(index, size, type, normalized, stride, ptr) { GLctx.vertexAttribPointer(index, size, type, !!normalized, stride, ptr) }

function _emscripten_glVertexPointer() { throw "Legacy GL function (glVertexPointer) called. If you want legacy GL emulation, you need to compile with -s LEGACY_GL_EMULATION=1 to enable legacy GL emulation." }

function _emscripten_glViewport(x0, x1, x2, x3) { GLctx["viewport"](x0, x1, x2, x3) }

function _emscripten_glWindowPos2d() {
    err("missing function: emscripten_glWindowPos2d");
    abort(-1)
}

function _emscripten_glWindowPos2dv() {
    err("missing function: emscripten_glWindowPos2dv");
    abort(-1)
}

function _emscripten_glWindowPos2f() {
    err("missing function: emscripten_glWindowPos2f");
    abort(-1)
}

function _emscripten_glWindowPos2fv() {
    err("missing function: emscripten_glWindowPos2fv");
    abort(-1)
}

function _emscripten_glWindowPos2i() {
    err("missing function: emscripten_glWindowPos2i");
    abort(-1)
}

function _emscripten_glWindowPos2iv() {
    err("missing function: emscripten_glWindowPos2iv");
    abort(-1)
}

function _emscripten_glWindowPos2s() {
    err("missing function: emscripten_glWindowPos2s");
    abort(-1)
}

function _emscripten_glWindowPos2sv() {
    err("missing function: emscripten_glWindowPos2sv");
    abort(-1)
}

function _emscripten_glWindowPos3d() {
    err("missing function: emscripten_glWindowPos3d");
    abort(-1)
}

function _emscripten_glWindowPos3dv() {
    err("missing function: emscripten_glWindowPos3dv");
    abort(-1)
}

function _emscripten_glWindowPos3f() {
    err("missing function: emscripten_glWindowPos3f");
    abort(-1)
}

function _emscripten_glWindowPos3fv() {
    err("missing function: emscripten_glWindowPos3fv");
    abort(-1)
}

function _emscripten_glWindowPos3i() {
    err("missing function: emscripten_glWindowPos3i");
    abort(-1)
}

function _emscripten_glWindowPos3iv() {
    err("missing function: emscripten_glWindowPos3iv");
    abort(-1)
}

function _emscripten_glWindowPos3s() {
    err("missing function: emscripten_glWindowPos3s");
    abort(-1)
}

function _emscripten_glWindowPos3sv() {
    err("missing function: emscripten_glWindowPos3sv");
    abort(-1)
}

function __setLetterbox(element, topBottom, leftRight) {
    if (JSEvents.isInternetExplorer()) {
        element.style.marginLeft = element.style.marginRight = leftRight + "px";
        element.style.marginTop = element.style.marginBottom = topBottom + "px"
    } else {
        element.style.paddingLeft = element.style.paddingRight = leftRight + "px";
        element.style.paddingTop = element.style.paddingBottom = topBottom + "px"
    }
}

function __emscripten_do_request_fullscreen(target, strategy) {
    if (typeof JSEvents.fullscreenEnabled() === "undefined") return -1;
    if (!JSEvents.fullscreenEnabled()) return -3;
    if (!target) target = "#canvas";
    target = JSEvents.findEventTarget(target);
    if (!target) return -4;
    if (!target.requestFullscreen && !target.msRequestFullscreen && !target.mozRequestFullScreen && !target.mozRequestFullscreen && !target.webkitRequestFullscreen) { return -3 }
    var canPerformRequests = JSEvents.canPerformEventHandlerRequests();
    if (!canPerformRequests) { if (strategy.deferUntilInEventHandler) { JSEvents.deferCall(JSEvents.requestFullscreen, 1, [target, strategy]); return 1 } else { return -2 } }
    return JSEvents.requestFullscreen(target, strategy)
}

function __registerRestoreOldStyle(canvas) {
    var canvasSize = __get_canvas_element_size(canvas);
    var oldWidth = canvasSize[0];
    var oldHeight = canvasSize[1];
    var oldCssWidth = canvas.style.width;
    var oldCssHeight = canvas.style.height;
    var oldBackgroundColor = canvas.style.backgroundColor;
    var oldDocumentBackgroundColor = document.body.style.backgroundColor;
    var oldPaddingLeft = canvas.style.paddingLeft;
    var oldPaddingRight = canvas.style.paddingRight;
    var oldPaddingTop = canvas.style.paddingTop;
    var oldPaddingBottom = canvas.style.paddingBottom;
    var oldMarginLeft = canvas.style.marginLeft;
    var oldMarginRight = canvas.style.marginRight;
    var oldMarginTop = canvas.style.marginTop;
    var oldMarginBottom = canvas.style.marginBottom;
    var oldDocumentBodyMargin = document.body.style.margin;
    var oldDocumentOverflow = document.documentElement.style.overflow;
    var oldDocumentScroll = document.body.scroll;
    var oldImageRendering = canvas.style.imageRendering;

    function restoreOldStyle() {
        var fullscreenElement = document.fullscreenElement || document.mozFullScreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
        if (!fullscreenElement) {
            document.removeEventListener("fullscreenchange", restoreOldStyle);
            document.removeEventListener("mozfullscreenchange", restoreOldStyle);
            document.removeEventListener("webkitfullscreenchange", restoreOldStyle);
            document.removeEventListener("MSFullscreenChange", restoreOldStyle);
            __set_canvas_element_size(canvas, oldWidth, oldHeight);
            canvas.style.width = oldCssWidth;
            canvas.style.height = oldCssHeight;
            canvas.style.backgroundColor = oldBackgroundColor;
            if (!oldDocumentBackgroundColor) document.body.style.backgroundColor = "white";
            document.body.style.backgroundColor = oldDocumentBackgroundColor;
            canvas.style.paddingLeft = oldPaddingLeft;
            canvas.style.paddingRight = oldPaddingRight;
            canvas.style.paddingTop = oldPaddingTop;
            canvas.style.paddingBottom = oldPaddingBottom;
            canvas.style.marginLeft = oldMarginLeft;
            canvas.style.marginRight = oldMarginRight;
            canvas.style.marginTop = oldMarginTop;
            canvas.style.marginBottom = oldMarginBottom;
            document.body.style.margin = oldDocumentBodyMargin;
            document.documentElement.style.overflow = oldDocumentOverflow;
            document.body.scroll = oldDocumentScroll;
            canvas.style.imageRendering = oldImageRendering;
            if (canvas.GLctxObject) canvas.GLctxObject.GLctx.viewport(0, 0, oldWidth, oldHeight);
            if (__currentFullscreenStrategy.canvasResizedCallback) { Module["dynCall_iiii"](__currentFullscreenStrategy.canvasResizedCallback, 37, 0, __currentFullscreenStrategy.canvasResizedCallbackUserData) }
        }
    }
    document.addEventListener("fullscreenchange", restoreOldStyle);
    document.addEventListener("mozfullscreenchange", restoreOldStyle);
    document.addEventListener("webkitfullscreenchange", restoreOldStyle);
    document.addEventListener("MSFullscreenChange", restoreOldStyle);
    return restoreOldStyle
}

function _emscripten_request_fullscreen_strategy(target, deferUntilInEventHandler, fullscreenStrategy) {
    var strategy = {};
    strategy.scaleMode = HEAP32[fullscreenStrategy >> 2];
    strategy.canvasResolutionScaleMode = HEAP32[fullscreenStrategy + 4 >> 2];
    strategy.filteringMode = HEAP32[fullscreenStrategy + 8 >> 2];
    strategy.deferUntilInEventHandler = deferUntilInEventHandler;
    strategy.canvasResizedCallback = HEAP32[fullscreenStrategy + 12 >> 2];
    strategy.canvasResizedCallbackUserData = HEAP32[fullscreenStrategy + 16 >> 2];
    __currentFullscreenStrategy = strategy;
    return __emscripten_do_request_fullscreen(target, strategy)
}

function _emscripten_request_pointerlock(target, deferUntilInEventHandler) {
    if (!target) target = "#canvas";
    target = JSEvents.findEventTarget(target);
    if (!target) return -4;
    if (!target.requestPointerLock && !target.mozRequestPointerLock && !target.webkitRequestPointerLock && !target.msRequestPointerLock) { return -1 }
    var canPerformRequests = JSEvents.canPerformEventHandlerRequests();
    if (!canPerformRequests) { if (deferUntilInEventHandler) { JSEvents.deferCall(JSEvents.requestPointerLock, 2, [target]); return 1 } else { return -2 } }
    return JSEvents.requestPointerLock(target)
}

function _emscripten_set_blur_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerFocusEventCallback(target, userData, useCapture, callbackfunc, 12, "blur", targetThread); return 0 }

function _emscripten_set_canvas_size(width, height) { Browser.setCanvasSize(width, height) }

function _emscripten_set_element_css_size(target, width, height) {
    if (target) target = JSEvents.findEventTarget(target);
    else target = Module["canvas"];
    if (!target) return -4;
    target.style.setProperty("width", width + "px");
    target.style.setProperty("height", height + "px");
    return 0
}

function _emscripten_set_focus_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerFocusEventCallback(target, userData, useCapture, callbackfunc, 13, "focus", targetThread); return 0 }

function _emscripten_set_fullscreenchange_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) {
    if (typeof JSEvents.fullscreenEnabled() === "undefined") return -1;
    if (!target) target = document;
    else { target = JSEvents.findEventTarget(target); if (!target) return -4 }
    JSEvents.registerFullscreenChangeEventCallback(target, userData, useCapture, callbackfunc, 19, "fullscreenchange", targetThread);
    JSEvents.registerFullscreenChangeEventCallback(target, userData, useCapture, callbackfunc, 19, "mozfullscreenchange", targetThread);
    JSEvents.registerFullscreenChangeEventCallback(target, userData, useCapture, callbackfunc, 19, "webkitfullscreenchange", targetThread);
    JSEvents.registerFullscreenChangeEventCallback(target, userData, useCapture, callbackfunc, 19, "msfullscreenchange", targetThread);
    return 0
}

function _emscripten_set_gamepadconnected_callback_on_thread(userData, useCapture, callbackfunc, targetThread) {
    if (!navigator.getGamepads && !navigator.webkitGetGamepads) return -1;
    JSEvents.registerGamepadEventCallback(window, userData, useCapture, callbackfunc, 26, "gamepadconnected", targetThread);
    return 0
}

function _emscripten_set_gamepaddisconnected_callback_on_thread(userData, useCapture, callbackfunc, targetThread) {
    if (!navigator.getGamepads && !navigator.webkitGetGamepads) return -1;
    JSEvents.registerGamepadEventCallback(window, userData, useCapture, callbackfunc, 27, "gamepaddisconnected", targetThread);
    return 0
}

function _emscripten_set_keydown_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerKeyEventCallback(target, userData, useCapture, callbackfunc, 2, "keydown", targetThread); return 0 }

function _emscripten_set_keypress_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerKeyEventCallback(target, userData, useCapture, callbackfunc, 1, "keypress", targetThread); return 0 }

function _emscripten_set_keyup_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerKeyEventCallback(target, userData, useCapture, callbackfunc, 3, "keyup", targetThread); return 0 }

function _emscripten_set_mousedown_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerMouseEventCallback(target, userData, useCapture, callbackfunc, 5, "mousedown", targetThread); return 0 }

function _emscripten_set_mouseenter_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerMouseEventCallback(target, userData, useCapture, callbackfunc, 33, "mouseenter", targetThread); return 0 }

function _emscripten_set_mouseleave_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerMouseEventCallback(target, userData, useCapture, callbackfunc, 34, "mouseleave", targetThread); return 0 }

function _emscripten_set_mousemove_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerMouseEventCallback(target, userData, useCapture, callbackfunc, 8, "mousemove", targetThread); return 0 }

function _emscripten_set_mouseup_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerMouseEventCallback(target, userData, useCapture, callbackfunc, 6, "mouseup", targetThread); return 0 }

function _emscripten_set_pointerlockchange_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) {
    if (!document || !document.body || !document.body.requestPointerLock && !document.body.mozRequestPointerLock && !document.body.webkitRequestPointerLock && !document.body.msRequestPointerLock) { return -1 }
    if (!target) target = document;
    else { target = JSEvents.findEventTarget(target); if (!target) return -4 }
    JSEvents.registerPointerlockChangeEventCallback(target, userData, useCapture, callbackfunc, 20, "pointerlockchange", targetThread);
    JSEvents.registerPointerlockChangeEventCallback(target, userData, useCapture, callbackfunc, 20, "mozpointerlockchange", targetThread);
    JSEvents.registerPointerlockChangeEventCallback(target, userData, useCapture, callbackfunc, 20, "webkitpointerlockchange", targetThread);
    JSEvents.registerPointerlockChangeEventCallback(target, userData, useCapture, callbackfunc, 20, "mspointerlockchange", targetThread);
    return 0
}

function _emscripten_set_resize_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerUiEventCallback(target, userData, useCapture, callbackfunc, 10, "resize", targetThread); return 0 }

function _emscripten_set_touchcancel_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerTouchEventCallback(target, userData, useCapture, callbackfunc, 25, "touchcancel", targetThread); return 0 }

function _emscripten_set_touchend_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerTouchEventCallback(target, userData, useCapture, callbackfunc, 23, "touchend", targetThread); return 0 }

function _emscripten_set_touchmove_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerTouchEventCallback(target, userData, useCapture, callbackfunc, 24, "touchmove", targetThread); return 0 }

function _emscripten_set_touchstart_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { JSEvents.registerTouchEventCallback(target, userData, useCapture, callbackfunc, 22, "touchstart", targetThread); return 0 }

function _emscripten_set_visibilitychange_callback_on_thread(userData, useCapture, callbackfunc, targetThread) { JSEvents.registerVisibilityChangeEventCallback(document, userData, useCapture, callbackfunc, 21, "visibilitychange", targetThread); return 0 }

function _emscripten_set_wheel_callback_on_thread(target, userData, useCapture, callbackfunc, targetThread) { target = JSEvents.findEventTarget(target); if (typeof target.onwheel !== "undefined") { JSEvents.registerWheelEventCallback(target, userData, useCapture, callbackfunc, 9, "wheel", targetThread); return 0 } else if (typeof target.onmousewheel !== "undefined") { JSEvents.registerWheelEventCallback(target, userData, useCapture, callbackfunc, 9, "mousewheel", targetThread); return 0 } else { return -1 } }
var EmterpreterAsync = {
    initted: false,
    state: 0,
    saveStack: "",
    yieldCallbacks: [],
    postAsync: null,
    restartFunc: null,
    asyncFinalizers: [],
    ensureInit: (function() {
        if (this.initted) return;
        this.initted = true
    }),
    setState: (function(s) {
        this.ensureInit();
        this.state = s;
        Module["setAsyncState"](s)
    }),
    handle: (function(doAsyncOp, yieldDuring) {
        Module["noExitRuntime"] = true;
        if (EmterpreterAsync.state === 0) {
            var stack = new Int32Array(HEAP32.subarray(EMTSTACKTOP >> 2, Module["emtStackSave"]() >> 2));
            var resumedCallbacksForYield = false;

            function resumeCallbacksForYield() {
                if (resumedCallbacksForYield) return;
                resumedCallbacksForYield = true;
                EmterpreterAsync.yieldCallbacks.forEach((function(func) { func() }));
                Browser.resumeAsyncCallbacks()
            }
            var callingDoAsyncOp = 1;
            doAsyncOp(function resume(post) {
                if (ABORT) { return }
                if (callingDoAsyncOp) {
                    assert(callingDoAsyncOp === 1);
                    callingDoAsyncOp++;
                    setTimeout((function() { resume(post) }), 0);
                    return
                }
                assert(EmterpreterAsync.state === 1 || EmterpreterAsync.state === 3);
                EmterpreterAsync.setState(3);
                if (yieldDuring) { resumeCallbacksForYield() }
                HEAP32.set(stack, EMTSTACKTOP >> 2);
                EmterpreterAsync.setState(2);
                if (Browser.mainLoop.func) { Browser.mainLoop.resume() }
                assert(!EmterpreterAsync.postAsync);
                EmterpreterAsync.postAsync = post || null;
                var asyncReturnValue;
                if (!EmterpreterAsync.restartFunc) { Module["emterpret"](stack[0]) } else { asyncReturnValue = EmterpreterAsync.restartFunc() }
                if (!yieldDuring && EmterpreterAsync.state === 0) { Browser.resumeAsyncCallbacks() }
                if (EmterpreterAsync.state === 0) {
                    EmterpreterAsync.restartFunc = null;
                    var asyncFinalizers = EmterpreterAsync.asyncFinalizers;
                    EmterpreterAsync.asyncFinalizers = [];
                    asyncFinalizers.forEach((function(func) { func(asyncReturnValue) }))
                }
            });
            callingDoAsyncOp = 0;
            EmterpreterAsync.setState(1);
            if (Browser.mainLoop.func) { Browser.mainLoop.pause() }
            if (yieldDuring) { setTimeout((function() { resumeCallbacksForYield() }), 0) } else { Browser.pauseAsyncCallbacks() }
        } else {
            assert(EmterpreterAsync.state === 2);
            EmterpreterAsync.setState(0);
            if (EmterpreterAsync.postAsync) {
                var ret = EmterpreterAsync.postAsync();
                EmterpreterAsync.postAsync = null;
                return ret
            }
        }
    })
};

function _emscripten_sleep(ms) { EmterpreterAsync.handle((function(resume) { setTimeout((function() { resume() }), ms) })) }

function _getenv(name) {
    if (name === 0) return 0;
    name = Pointer_stringify(name);
    if (!ENV.hasOwnProperty(name)) return 0;
    if (_getenv.ret) _free(_getenv.ret);
    _getenv.ret = allocateUTF8(ENV[name]);
    return _getenv.ret
}

function _gettimeofday(ptr) {
    var now = Date.now();
    HEAP32[ptr >> 2] = now / 1e3 | 0;
    HEAP32[ptr + 4 >> 2] = now % 1e3 * 1e3 | 0;
    return 0
}

function _glClear(x0) { GLctx["clear"](x0) }

function _llvm_stackrestore(p) {
    var self = _llvm_stacksave;
    var ret = self.LLVM_SAVEDSTACKS[p];
    self.LLVM_SAVEDSTACKS.splice(p, 1);
    stackRestore(ret)
}

function _llvm_stacksave() {
    var self = _llvm_stacksave;
    if (!self.LLVM_SAVEDSTACKS) { self.LLVM_SAVEDSTACKS = [] }
    self.LLVM_SAVEDSTACKS.push(stackSave());
    return self.LLVM_SAVEDSTACKS.length - 1
}
var ___tm_current = STATICTOP;
STATICTOP += 48;
var ___tm_timezone = allocate(intArrayFromString("GMT"), "i8", ALLOC_STATIC);

function _tzset() {
    if (_tzset.called) return;
    _tzset.called = true;
    HEAP32[__get_timezone() >> 2] = (new Date).getTimezoneOffset() * 60;
    var winter = new Date(2e3, 0, 1);
    var summer = new Date(2e3, 6, 1);
    HEAP32[__get_daylight() >> 2] = Number(winter.getTimezoneOffset() != summer.getTimezoneOffset());

    function extractZone(date) { var match = date.toTimeString().match(/\(([A-Za-z ]+)\)$/); return match ? match[1] : "GMT" }
    var winterName = extractZone(winter);
    var summerName = extractZone(summer);
    var winterNamePtr = allocate(intArrayFromString(winterName), "i8", ALLOC_NORMAL);
    var summerNamePtr = allocate(intArrayFromString(summerName), "i8", ALLOC_NORMAL);
    if (summer.getTimezoneOffset() < winter.getTimezoneOffset()) {
        HEAP32[__get_tzname() >> 2] = winterNamePtr;
        HEAP32[__get_tzname() + 4 >> 2] = summerNamePtr
    } else {
        HEAP32[__get_tzname() >> 2] = summerNamePtr;
        HEAP32[__get_tzname() + 4 >> 2] = winterNamePtr
    }
}

function _localtime_r(time, tmPtr) {
    _tzset();
    var date = new Date(HEAP32[time >> 2] * 1e3);
    HEAP32[tmPtr >> 2] = date.getSeconds();
    HEAP32[tmPtr + 4 >> 2] = date.getMinutes();
    HEAP32[tmPtr + 8 >> 2] = date.getHours();
    HEAP32[tmPtr + 12 >> 2] = date.getDate();
    HEAP32[tmPtr + 16 >> 2] = date.getMonth();
    HEAP32[tmPtr + 20 >> 2] = date.getFullYear() - 1900;
    HEAP32[tmPtr + 24 >> 2] = date.getDay();
    var start = new Date(date.getFullYear(), 0, 1);
    var yday = (date.getTime() - start.getTime()) / (1e3 * 60 * 60 * 24) | 0;
    HEAP32[tmPtr + 28 >> 2] = yday;
    HEAP32[tmPtr + 36 >> 2] = -(date.getTimezoneOffset() * 60);
    var summerOffset = (new Date(2e3, 6, 1)).getTimezoneOffset();
    var winterOffset = start.getTimezoneOffset();
    var dst = (summerOffset != winterOffset && date.getTimezoneOffset() == Math.min(winterOffset, summerOffset)) | 0;
    HEAP32[tmPtr + 32 >> 2] = dst;
    var zonePtr = HEAP32[__get_tzname() + (dst ? 4 : 0) >> 2];
    HEAP32[tmPtr + 40 >> 2] = zonePtr;
    return tmPtr
}

function _localtime(time) { return _localtime_r(time, ___tm_current) }

function _emscripten_memcpy_big(dest, src, num) { HEAPU8.set(HEAPU8.subarray(src, src + num), dest); return dest }

function _usleep(useconds) { var msec = useconds / 1e3; if ((ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) && self["performance"] && self["performance"]["now"]) { var start = self["performance"]["now"](); while (self["performance"]["now"]() - start < msec) {} } else { var start = Date.now(); while (Date.now() - start < msec) {} } return 0 }

function _nanosleep(rqtp, rmtp) {
    var seconds = HEAP32[rqtp >> 2];
    var nanoseconds = HEAP32[rqtp + 4 >> 2];
    if (rmtp !== 0) {
        HEAP32[rmtp >> 2] = 0;
        HEAP32[rmtp + 4 >> 2] = 0
    }
    return _usleep(seconds * 1e6 + nanoseconds / 1e3)
}

function _sigaction(signum, act, oldact) { return 0 }
var __sigalrm_handler = 0;

function _signal(sig, func) { if (sig == 14) { __sigalrm_handler = func } else {} return 0 }

function _time(ptr) { var ret = Date.now() / 1e3 | 0; if (ptr) { HEAP32[ptr >> 2] = ret } return ret }
FS.staticInit();
__ATINIT__.unshift((function() { if (!Module["noFSInit"] && !FS.init.initialized) FS.init() }));
__ATMAIN__.push((function() { FS.ignorePermissions = false }));
__ATEXIT__.push((function() { FS.quit() }));
__ATINIT__.unshift((function() { TTY.init() }));
__ATEXIT__.push((function() { TTY.shutdown() }));
if (ENVIRONMENT_IS_NODE) {
    var fs = require("fs");
    var NODEJS_PATH = require("path");
    NODEFS.staticInit()
}
if (ENVIRONMENT_IS_NODE) { _emscripten_get_now = function _emscripten_get_now_actual() { var t = process["hrtime"](); return t[0] * 1e3 + t[1] / 1e6 } } else if (typeof dateNow !== "undefined") { _emscripten_get_now = dateNow } else if (typeof self === "object" && self["performance"] && typeof self["performance"]["now"] === "function") { _emscripten_get_now = (function() { return self["performance"]["now"]() }) } else if (typeof performance === "object" && typeof performance["now"] === "function") { _emscripten_get_now = (function() { return performance["now"]() }) } else { _emscripten_get_now = Date.now }
Module["requestFullScreen"] = function Module_requestFullScreen(lockPointer, resizeCanvas, vrDevice) {
    err("Module.requestFullScreen is deprecated. Please call Module.requestFullscreen instead.");
    Module["requestFullScreen"] = Module["requestFullscreen"];
    Browser.requestFullScreen(lockPointer, resizeCanvas, vrDevice)
};
Module["requestFullscreen"] = function Module_requestFullscreen(lockPointer, resizeCanvas, vrDevice) { Browser.requestFullscreen(lockPointer, resizeCanvas, vrDevice) };
Module["requestAnimationFrame"] = function Module_requestAnimationFrame(func) { Browser.requestAnimationFrame(func) };
Module["setCanvasSize"] = function Module_setCanvasSize(width, height, noUpdates) { Browser.setCanvasSize(width, height, noUpdates) };
Module["pauseMainLoop"] = function Module_pauseMainLoop() { Browser.mainLoop.pause() };
Module["resumeMainLoop"] = function Module_resumeMainLoop() { Browser.mainLoop.resume() };
Module["getUserMedia"] = function Module_getUserMedia() { Browser.getUserMedia() };
Module["createContext"] = function Module_createContext(canvas, useWebGL, setInModule, webGLContextAttributes) { return Browser.createContext(canvas, useWebGL, setInModule, webGLContextAttributes) };
var GLctx;
GL.init();
JSEvents.staticInit();
DYNAMICTOP_PTR = staticAlloc(4);
STACK_BASE = STACKTOP = alignMemory(STATICTOP);
STACK_MAX = STACK_BASE + TOTAL_STACK;
DYNAMIC_BASE = alignMemory(STACK_MAX);
HEAP32[DYNAMICTOP_PTR >> 2] = DYNAMIC_BASE;
staticSealed = true;

function intArrayFromString(stringy, dontAddNull, length) { var len = length > 0 ? length : lengthBytesUTF8(stringy) + 1; var u8array = new Array(len); var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length); if (dontAddNull) u8array.length = numBytesWritten; return u8array }
Module["wasmTableSize"] = 1786;
Module["wasmMaxTableSize"] = 1786;
Module.asmGlobalArg = {};
Module.asmLibraryArg = { "f": abort, "Wn": enlargeMemory, "Yl": getTotalMemory, "Wj": abortOnCannotGrowMemory, "Wh": ___buildEnvironment, "Xf": ___lock, "Q": ___setErrNo, "Rb": ___syscall140, "qa": ___syscall145, "t": ___syscall146, "l": ___syscall221, "Ln": ___syscall5, "X": ___syscall54, "W": ___syscall6, "s": ___unlock, "r": _clock_gettime, "Nm": _dlclose, "Cm": _dlerror, "V": _dlsym, "hm": _eglBindAPI, "Xl": _eglChooseConfig, "Ml": _eglCreateContext, "Bl": _eglCreateWindowSurface, "ql": _eglDestroyContext, "fl": _eglDestroySurface, "Wk": _eglGetConfigAttrib, "U": _eglGetDisplay, "Bk": _eglGetError, "qk": _eglGetProcAddress, "fk": _eglInitialize, "Vj": _eglMakeCurrent, "Kj": _eglQueryString, "zj": _eglSwapBuffers, "oj": _eglSwapInterval, "dj": _eglTerminate, "Ui": _eglWaitGL, "Ji": _eglWaitNative, "h": _emscripten_asm_const_i, "k": _emscripten_asm_const_ii, "T": _emscripten_asm_const_iii, "Vh": _emscripten_asm_const_iiii, "S": _emscripten_asm_const_iiiii, "Ah": _emscripten_asm_const_iiiiii, "ph": _emscripten_exit_fullscreen, "eh": _emscripten_exit_pointerlock, "q": _emscripten_get_device_pixel_ratio, "i": _emscripten_get_element_css_size, "R": _emscripten_get_gamepad_status, "rg": _emscripten_get_num_gamepads, "gg": _emscripten_glAccum, "Wf": _emscripten_glActiveTexture, "Lf": _emscripten_glAlphaFunc, "Af": _emscripten_glAreTexturesResident, "pf": _emscripten_glArrayElement, "df": _emscripten_glAttachObjectARB, "Ue": _emscripten_glAttachShader, "Je": _emscripten_glBegin, "ye": _emscripten_glBeginConditionalRender, "ne": _emscripten_glBeginQuery, "ce": _emscripten_glBeginTransformFeedback, "Td": _emscripten_glBindAttribLocation, "Id": _emscripten_glBindBuffer, "xd": _emscripten_glBindBufferBase, "md": _emscripten_glBindBufferRange, "bd": _emscripten_glBindFragDataLocation, "Sc": _emscripten_glBindFramebuffer, "Hc": _emscripten_glBindProgramARB, "wc": _emscripten_glBindRenderbuffer, "lc": _emscripten_glBindTexture, "ac": _emscripten_glBindVertexArray, "Qb": _emscripten_glBitmap, "Fb": _emscripten_glBlendColor, "ub": _emscripten_glBlendEquation, "jb": _emscripten_glBlendEquationSeparate, "_a": _emscripten_glBlendFunc, "Pa": _emscripten_glBlendFuncSeparate, "Ea": _emscripten_glBlitFramebuffer, "Aa": _emscripten_glBufferData, "za": _emscripten_glBufferSubData, "wa": _emscripten_glCallList, "pa": _emscripten_glCallLists, "oa": _emscripten_glCheckFramebufferStatus, "na": _emscripten_glClampColor, "ma": _emscripten_glClear, "la": _emscripten_glClearAccum, "ka": _emscripten_glClearBufferfi, "ja": _emscripten_glClearBufferfv, "ia": _emscripten_glClearBufferiv, "ha": _emscripten_glClearBufferuiv, "ga": _emscripten_glClearColor, "fa": _emscripten_glClearDepth, "ea": _emscripten_glClearDepthf, "da": _emscripten_glClearIndex, "ca": _emscripten_glClearStencil, "ba": _emscripten_glClientActiveTexture, "aa": _emscripten_glClipPlane, "$": _emscripten_glColor3b, "_": _emscripten_glColor3bv, "Z": _emscripten_glColor3d, "Y": _emscripten_glColor3dv, "Vn": _emscripten_glColor3f, "Un": _emscripten_glColor3fv, "Tn": _emscripten_glColor3i, "Sn": _emscripten_glColor3iv, "Rn": _emscripten_glColor3s, "Qn": _emscripten_glColor3sv, "Pn": _emscripten_glColor3ub, "On": _emscripten_glColor3ubv, "Nn": _emscripten_glColor3ui, "Mn": _emscripten_glColor3uiv, "Kn": _emscripten_glColor3us, "Jn": _emscripten_glColor3usv, "In": _emscripten_glColor4b, "Hn": _emscripten_glColor4bv, "Gn": _emscripten_glColor4d, "Fn": _emscripten_glColor4dv, "En": _emscripten_glColor4f, "Dn": _emscripten_glColor4fv, "Cn": _emscripten_glColor4i, "Bn": _emscripten_glColor4iv, "An": _emscripten_glColor4s, "zn": _emscripten_glColor4sv, "yn": _emscripten_glColor4ub, "xn": _emscripten_glColor4ubv, "wn": _emscripten_glColor4ui, "vn": _emscripten_glColor4uiv, "un": _emscripten_glColor4us, "tn": _emscripten_glColor4usv, "sn": _emscripten_glColorMask, "rn": _emscripten_glColorMaski, "qn": _emscripten_glColorMaterial, "pn": _emscripten_glColorPointer, "on": _emscripten_glColorSubTable, "nn": _emscripten_glColorTable, "mn": _emscripten_glColorTableParameterfv, "ln": _emscripten_glColorTableParameteriv, "kn": _emscripten_glCompileShader, "jn": _emscripten_glCompressedTexImage1D, "hn": _emscripten_glCompressedTexImage2D, "gn": _emscripten_glCompressedTexImage3D, "fn": _emscripten_glCompressedTexSubImage1D, "en": _emscripten_glCompressedTexSubImage2D, "dn": _emscripten_glCompressedTexSubImage3D, "cn": _emscripten_glConvolutionFilter1D, "bn": _emscripten_glConvolutionFilter2D, "an": _emscripten_glConvolutionParameterf, "$m": _emscripten_glConvolutionParameterfv, "_m": _emscripten_glConvolutionParameteri, "Zm": _emscripten_glConvolutionParameteriv, "Ym": _emscripten_glCopyColorSubTable, "Xm": _emscripten_glCopyColorTable, "Wm": _emscripten_glCopyConvolutionFilter1D, "Vm": _emscripten_glCopyConvolutionFilter2D, "Um": _emscripten_glCopyPixels, "Tm": _emscripten_glCopyTexImage1D, "Sm": _emscripten_glCopyTexImage2D, "Rm": _emscripten_glCopyTexSubImage1D, "Qm": _emscripten_glCopyTexSubImage2D, "Pm": _emscripten_glCopyTexSubImage3D, "Om": _emscripten_glCreateProgram, "Mm": _emscripten_glCreateProgramObjectARB, "Lm": _emscripten_glCreateShader, "Km": _emscripten_glCreateShaderObjectARB, "Jm": _emscripten_glCullFace, "Im": _emscripten_glDeleteBuffers, "Hm": _emscripten_glDeleteFramebuffers, "Gm": _emscripten_glDeleteLists, "Fm": _emscripten_glDeleteObjectARB, "Em": _emscripten_glDeleteProgram, "Dm": _emscripten_glDeleteProgramsARB, "Bm": _emscripten_glDeleteQueries, "Am": _emscripten_glDeleteRenderbuffers, "zm": _emscripten_glDeleteShader, "ym": _emscripten_glDeleteTextures, "xm": _emscripten_glDeleteVertexArrays, "wm": _emscripten_glDepthFunc, "vm": _emscripten_glDepthMask, "um": _emscripten_glDepthRange, "tm": _emscripten_glDepthRangef, "sm": _emscripten_glDetachObjectARB, "rm": _emscripten_glDetachShader, "qm": _emscripten_glDisable, "pm": _emscripten_glDisableClientState, "om": _emscripten_glDisableVertexAttribArray, "nm": _emscripten_glDisablei, "mm": _emscripten_glDrawArrays, "lm": _emscripten_glDrawArraysInstanced, "km": _emscripten_glDrawBuffer, "jm": _emscripten_glDrawBuffers, "im": _emscripten_glDrawElements, "gm": _emscripten_glDrawElementsInstanced, "fm": _emscripten_glDrawPixels, "em": _emscripten_glDrawRangeElements, "dm": _emscripten_glEdgeFlag, "cm": _emscripten_glEdgeFlagPointer, "bm": _emscripten_glEdgeFlagv, "am": _emscripten_glEnable, "$l": _emscripten_glEnableClientState, "_l": _emscripten_glEnableVertexAttribArray, "Zl": _emscripten_glEnablei, "Wl": _emscripten_glEnd, "Vl": _emscripten_glEndConditionalRender, "Ul": _emscripten_glEndList, "Tl": _emscripten_glEndQuery, "Sl": _emscripten_glEndTransformFeedback, "Rl": _emscripten_glEvalCoord1d, "Ql": _emscripten_glEvalCoord1dv, "Pl": _emscripten_glEvalCoord1f, "Ol": _emscripten_glEvalCoord1fv, "Nl": _emscripten_glEvalCoord2d, "Ll": _emscripten_glEvalCoord2dv, "Kl": _emscripten_glEvalCoord2f, "Jl": _emscripten_glEvalCoord2fv, "Il": _emscripten_glEvalMesh1, "Hl": _emscripten_glEvalMesh2, "Gl": _emscripten_glEvalPoint1, "Fl": _emscripten_glEvalPoint2, "El": _emscripten_glFeedbackBuffer, "Dl": _emscripten_glFinish, "Cl": _emscripten_glFlush, "Al": _emscripten_glFogCoordPointer, "zl": _emscripten_glFogCoordd, "yl": _emscripten_glFogCoorddv, "xl": _emscripten_glFogCoordf, "wl": _emscripten_glFogCoordfv, "vl": _emscripten_glFogf, "ul": _emscripten_glFogfv, "tl": _emscripten_glFogi, "sl": _emscripten_glFogiv, "rl": _emscripten_glFramebufferRenderbuffer, "pl": _emscripten_glFramebufferTexture1D, "ol": _emscripten_glFramebufferTexture2D, "nl": _emscripten_glFramebufferTexture3D, "ml": _emscripten_glFramebufferTextureLayer, "ll": _emscripten_glFrontFace, "kl": _emscripten_glFrustum, "jl": _emscripten_glGenBuffers, "il": _emscripten_glGenFramebuffers, "hl": _emscripten_glGenLists, "gl": _emscripten_glGenProgramsARB, "el": _emscripten_glGenQueries, "dl": _emscripten_glGenRenderbuffers, "cl": _emscripten_glGenTextures, "bl": _emscripten_glGenVertexArrays, "al": _emscripten_glGenerateMipmap, "$k": _emscripten_glGetActiveAttrib, "_k": _emscripten_glGetActiveUniform, "Zk": _emscripten_glGetActiveUniformBlockName, "Yk": _emscripten_glGetActiveUniformBlockiv, "Xk": _emscripten_glGetActiveUniformName, "Vk": _emscripten_glGetActiveUniformsiv, "Uk": _emscripten_glGetAttachedObjectsARB, "Tk": _emscripten_glGetAttachedShaders, "Sk": _emscripten_glGetAttribLocation, "Rk": _emscripten_glGetBooleani_v, "Qk": _emscripten_glGetBooleanv, "Pk": _emscripten_glGetBufferParameteriv, "Ok": _emscripten_glGetBufferPointerv, "Nk": _emscripten_glGetBufferSubData, "Mk": _emscripten_glGetClipPlane, "Lk": _emscripten_glGetColorTable, "Kk": _emscripten_glGetColorTableParameterfv, "Jk": _emscripten_glGetColorTableParameteriv, "Ik": _emscripten_glGetCompressedTexImage, "Hk": _emscripten_glGetConvolutionFilter, "Gk": _emscripten_glGetConvolutionParameterfv, "Fk": _emscripten_glGetConvolutionParameteriv, "Ek": _emscripten_glGetDoublev, "Dk": _emscripten_glGetError, "Ck": _emscripten_glGetFloatv, "Ak": _emscripten_glGetFragDataLocation, "zk": _emscripten_glGetFramebufferAttachmentParameteriv, "yk": _emscripten_glGetHandleARB, "xk": _emscripten_glGetHistogram, "wk": _emscripten_glGetHistogramParameterfv, "vk": _emscripten_glGetHistogramParameteriv, "uk": _emscripten_glGetInfoLogARB, "tk": _emscripten_glGetIntegeri_v, "sk": _emscripten_glGetIntegerv, "rk": _emscripten_glGetLightfv, "pk": _emscripten_glGetLightiv, "ok": _emscripten_glGetMapdv, "nk": _emscripten_glGetMapfv, "mk": _emscripten_glGetMapiv, "lk": _emscripten_glGetMaterialfv, "kk": _emscripten_glGetMaterialiv, "jk": _emscripten_glGetMinmax, "ik": _emscripten_glGetMinmaxParameterfv, "hk": _emscripten_glGetMinmaxParameteriv, "gk": _emscripten_glGetObjectParameterfvARB, "ek": _emscripten_glGetObjectParameterivARB, "dk": _emscripten_glGetPixelMapfv, "ck": _emscripten_glGetPixelMapuiv, "bk": _emscripten_glGetPixelMapusv, "ak": _emscripten_glGetPointerv, "$j": _emscripten_glGetPolygonStipple, "_j": _emscripten_glGetProgramEnvParameterdvARB, "Zj": _emscripten_glGetProgramEnvParameterfvARB, "Yj": _emscripten_glGetProgramInfoLog, "Xj": _emscripten_glGetProgramLocalParameterdvARB, "Uj": _emscripten_glGetProgramLocalParameterfvARB, "Tj": _emscripten_glGetProgramStringARB, "Sj": _emscripten_glGetProgramiv, "Rj": _emscripten_glGetQueryObjectiv, "Qj": _emscripten_glGetQueryObjectuiv, "Pj": _emscripten_glGetQueryiv, "Oj": _emscripten_glGetRenderbufferParameteriv, "Nj": _emscripten_glGetSeparableFilter, "Mj": _emscripten_glGetShaderInfoLog, "Lj": _emscripten_glGetShaderPrecisionFormat, "Jj": _emscripten_glGetShaderSource, "Ij": _emscripten_glGetShaderiv, "Hj": _emscripten_glGetString, "Gj": _emscripten_glGetStringi, "Fj": _emscripten_glGetTexEnvfv, "Ej": _emscripten_glGetTexEnviv, "Dj": _emscripten_glGetTexGendv, "Cj": _emscripten_glGetTexGenfv, "Bj": _emscripten_glGetTexGeniv, "Aj": _emscripten_glGetTexImage, "yj": _emscripten_glGetTexLevelParameterfv, "xj": _emscripten_glGetTexLevelParameteriv, "wj": _emscripten_glGetTexParameterIiv, "vj": _emscripten_glGetTexParameterIuiv, "uj": _emscripten_glGetTexParameterfv, "tj": _emscripten_glGetTexParameteriv, "sj": _emscripten_glGetTransformFeedbackVarying, "rj": _emscripten_glGetUniformBlockIndex, "qj": _emscripten_glGetUniformIndices, "pj": _emscripten_glGetUniformLocation, "nj": _emscripten_glGetUniformfv, "mj": _emscripten_glGetUniformiv, "lj": _emscripten_glGetUniformuiv, "kj": _emscripten_glGetVertexAttribIiv, "jj": _emscripten_glGetVertexAttribIuiv, "ij": _emscripten_glGetVertexAttribPointerv, "hj": _emscripten_glGetVertexAttribdv, "gj": _emscripten_glGetVertexAttribfv, "fj": _emscripten_glGetVertexAttribiv, "ej": _emscripten_glHint, "cj": _emscripten_glHistogram, "bj": _emscripten_glIndexMask, "aj": _emscripten_glIndexPointer, "$i": _emscripten_glIndexd, "_i": _emscripten_glIndexdv, "Zi": _emscripten_glIndexf, "Yi": _emscripten_glIndexfv, "Xi": _emscripten_glIndexi, "Wi": _emscripten_glIndexiv, "Vi": _emscripten_glIndexs, "Ti": _emscripten_glIndexsv, "Si": _emscripten_glIndexub, "Ri": _emscripten_glIndexubv, "Qi": _emscripten_glInitNames, "Pi": _emscripten_glInterleavedArrays, "Oi": _emscripten_glIsBuffer, "Ni": _emscripten_glIsEnabled, "Mi": _emscripten_glIsEnabledi, "Li": _emscripten_glIsFramebuffer, "Ki": _emscripten_glIsList, "Ii": _emscripten_glIsProgram, "Hi": _emscripten_glIsQuery, "Gi": _emscripten_glIsRenderbuffer, "Fi": _emscripten_glIsShader, "Ei": _emscripten_glIsTexture, "Di": _emscripten_glIsVertexArray, "Ci": _emscripten_glLightModelf, "Bi": _emscripten_glLightModelfv, "Ai": _emscripten_glLightModeli, "zi": _emscripten_glLightModeliv, "yi": _emscripten_glLightf, "xi": _emscripten_glLightfv, "wi": _emscripten_glLighti, "vi": _emscripten_glLightiv, "ui": _emscripten_glLineStipple, "ti": _emscripten_glLineWidth, "si": _emscripten_glLinkProgram, "ri": _emscripten_glListBase, "qi": _emscripten_glLoadIdentity, "pi": _emscripten_glLoadMatrixd, "oi": _emscripten_glLoadMatrixf, "ni": _emscripten_glLoadName, "mi": _emscripten_glLoadTransposeMatrixd, "li": _emscripten_glLoadTransposeMatrixf, "ki": _emscripten_glLogicOp, "ji": _emscripten_glMap1d, "ii": _emscripten_glMap1f, "hi": _emscripten_glMap2d, "gi": _emscripten_glMap2f, "fi": _emscripten_glMapBuffer, "ei": _emscripten_glMapGrid1d, "di": _emscripten_glMapGrid1f, "ci": _emscripten_glMapGrid2d, "bi": _emscripten_glMapGrid2f, "ai": _emscripten_glMaterialf, "$h": _emscripten_glMaterialfv, "_h": _emscripten_glMateriali, "Zh": _emscripten_glMaterialiv, "Yh": _emscripten_glMatrixMode, "Xh": _emscripten_glMinmax, "Uh": _emscripten_glMultMatrixd, "Th": _emscripten_glMultMatrixf, "Sh": _emscripten_glMultTransposeMatrixd, "Rh": _emscripten_glMultTransposeMatrixf, "Qh": _emscripten_glMultiDrawArrays, "Ph": _emscripten_glMultiDrawElements, "Oh": _emscripten_glMultiTexCoord1d, "Nh": _emscripten_glMultiTexCoord1dv, "Mh": _emscripten_glMultiTexCoord1f, "Lh": _emscripten_glMultiTexCoord1fv, "Kh": _emscripten_glMultiTexCoord1i, "Jh": _emscripten_glMultiTexCoord1iv, "Ih": _emscripten_glMultiTexCoord1s, "Hh": _emscripten_glMultiTexCoord1sv, "Gh": _emscripten_glMultiTexCoord2d, "Fh": _emscripten_glMultiTexCoord2dv, "Eh": _emscripten_glMultiTexCoord2f, "Dh": _emscripten_glMultiTexCoord2fv, "Ch": _emscripten_glMultiTexCoord2i, "Bh": _emscripten_glMultiTexCoord2iv, "zh": _emscripten_glMultiTexCoord2s, "yh": _emscripten_glMultiTexCoord2sv, "xh": _emscripten_glMultiTexCoord3d, "wh": _emscripten_glMultiTexCoord3dv, "vh": _emscripten_glMultiTexCoord3f, "uh": _emscripten_glMultiTexCoord3fv, "th": _emscripten_glMultiTexCoord3i, "sh": _emscripten_glMultiTexCoord3iv, "rh": _emscripten_glMultiTexCoord3s, "qh": _emscripten_glMultiTexCoord3sv, "oh": _emscripten_glMultiTexCoord4d, "nh": _emscripten_glMultiTexCoord4dv, "mh": _emscripten_glMultiTexCoord4f, "lh": _emscripten_glMultiTexCoord4fv, "kh": _emscripten_glMultiTexCoord4i, "jh": _emscripten_glMultiTexCoord4iv, "ih": _emscripten_glMultiTexCoord4s, "hh": _emscripten_glMultiTexCoord4sv, "gh": _emscripten_glNewList, "fh": _emscripten_glNormal3b, "dh": _emscripten_glNormal3bv, "ch": _emscripten_glNormal3d, "bh": _emscripten_glNormal3dv, "ah": _emscripten_glNormal3f, "$g": _emscripten_glNormal3fv, "_g": _emscripten_glNormal3i, "Zg": _emscripten_glNormal3iv, "Yg": _emscripten_glNormal3s, "Xg": _emscripten_glNormal3sv, "Wg": _emscripten_glNormalPointer, "Vg": _emscripten_glOrtho, "Ug": _emscripten_glPassThrough, "Tg": _emscripten_glPixelMapfv, "Sg": _emscripten_glPixelMapuiv, "Rg": _emscripten_glPixelMapusv, "Qg": _emscripten_glPixelStoref, "Pg": _emscripten_glPixelStorei, "Og": _emscripten_glPixelTransferf, "Ng": _emscripten_glPixelTransferi, "Mg": _emscripten_glPixelZoom, "Lg": _emscripten_glPointParameterf, "Kg": _emscripten_glPointParameterfv, "Jg": _emscripten_glPointParameteri, "Ig": _emscripten_glPointParameteriv, "Hg": _emscripten_glPointSize, "Gg": _emscripten_glPolygonMode, "Fg": _emscripten_glPolygonOffset, "Eg": _emscripten_glPolygonStipple, "Dg": _emscripten_glPopAttrib, "Cg": _emscripten_glPopClientAttrib, "Bg": _emscripten_glPopMatrix, "Ag": _emscripten_glPopName, "zg": _emscripten_glPrimitiveRestartIndex, "yg": _emscripten_glPrioritizeTextures, "xg": _emscripten_glProgramEnvParameter4dARB, "wg": _emscripten_glProgramEnvParameter4dvARB, "vg": _emscripten_glProgramEnvParameter4fARB, "ug": _emscripten_glProgramEnvParameter4fvARB, "tg": _emscripten_glProgramLocalParameter4dARB, "sg": _emscripten_glProgramLocalParameter4dvARB, "qg": _emscripten_glProgramLocalParameter4fARB, "pg": _emscripten_glProgramLocalParameter4fvARB, "og": _emscripten_glProgramStringARB, "ng": _emscripten_glPushAttrib, "mg": _emscripten_glPushClientAttrib, "lg": _emscripten_glPushMatrix, "kg": _emscripten_glPushName, "jg": _emscripten_glRasterPos2d, "ig": _emscripten_glRasterPos2dv, "hg": _emscripten_glRasterPos2f, "fg": _emscripten_glRasterPos2fv, "eg": _emscripten_glRasterPos2i, "dg": _emscripten_glRasterPos2iv, "cg": _emscripten_glRasterPos2s, "bg": _emscripten_glRasterPos2sv, "ag": _emscripten_glRasterPos3d, "$f": _emscripten_glRasterPos3dv, "_f": _emscripten_glRasterPos3f, "Zf": _emscripten_glRasterPos3fv, "Yf": _emscripten_glRasterPos3i, "Vf": _emscripten_glRasterPos3iv, "Uf": _emscripten_glRasterPos3s, "Tf": _emscripten_glRasterPos3sv, "Sf": _emscripten_glRasterPos4d, "Rf": _emscripten_glRasterPos4dv, "Qf": _emscripten_glRasterPos4f, "Pf": _emscripten_glRasterPos4fv, "Of": _emscripten_glRasterPos4i, "Nf": _emscripten_glRasterPos4iv, "Mf": _emscripten_glRasterPos4s, "Kf": _emscripten_glRasterPos4sv, "Jf": _emscripten_glReadBuffer, "If": _emscripten_glReadPixels, "Hf": _emscripten_glRectd, "Gf": _emscripten_glRectdv, "Ff": _emscripten_glRectf, "Ef": _emscripten_glRectfv, "Df": _emscripten_glRecti, "Cf": _emscripten_glRectiv, "Bf": _emscripten_glRects, "zf": _emscripten_glRectsv, "yf": _emscripten_glReleaseShaderCompiler, "xf": _emscripten_glRenderMode, "wf": _emscripten_glRenderbufferStorage, "vf": _emscripten_glRenderbufferStorageMultisample, "uf": _emscripten_glResetHistogram, "tf": _emscripten_glResetMinmax, "sf": _emscripten_glRotated, "rf": _emscripten_glRotatef, "qf": _emscripten_glSampleCoverage, "of": _emscripten_glScaled, "nf": _emscripten_glScalef, "mf": _emscripten_glScissor, "lf": _emscripten_glSecondaryColor3b, "kf": _emscripten_glSecondaryColor3bv, "jf": _emscripten_glSecondaryColor3d, "hf": _emscripten_glSecondaryColor3dv, "gf": _emscripten_glSecondaryColor3f, "ff": _emscripten_glSecondaryColor3fv, "ef": _emscripten_glSecondaryColor3i, "cf": _emscripten_glSecondaryColor3iv, "bf": _emscripten_glSecondaryColor3s, "af": _emscripten_glSecondaryColor3sv, "$e": _emscripten_glSecondaryColor3ub, "_e": _emscripten_glSecondaryColor3ubv, "Ze": _emscripten_glSecondaryColor3ui, "Ye": _emscripten_glSecondaryColor3uiv, "Xe": _emscripten_glSecondaryColor3us, "We": _emscripten_glSecondaryColor3usv, "Ve": _emscripten_glSecondaryColorPointer, "Te": _emscripten_glSelectBuffer, "Se": _emscripten_glSeparableFilter2D, "Re": _emscripten_glShadeModel, "Qe": _emscripten_glShaderBinary, "Pe": _emscripten_glShaderSource, "Oe": _emscripten_glStencilFunc, "Ne": _emscripten_glStencilFuncSeparate, "Me": _emscripten_glStencilMask, "Le": _emscripten_glStencilMaskSeparate, "Ke": _emscripten_glStencilOp, "Ie": _emscripten_glStencilOpSeparate, "He": _emscripten_glTexBuffer, "Ge": _emscripten_glTexCoord1d, "Fe": _emscripten_glTexCoord1dv, "Ee": _emscripten_glTexCoord1f, "De": _emscripten_glTexCoord1fv, "Ce": _emscripten_glTexCoord1i, "Be": _emscripten_glTexCoord1iv, "Ae": _emscripten_glTexCoord1s, "ze": _emscripten_glTexCoord1sv, "xe": _emscripten_glTexCoord2d, "we": _emscripten_glTexCoord2dv, "ve": _emscripten_glTexCoord2f, "ue": _emscripten_glTexCoord2fv, "te": _emscripten_glTexCoord2i, "se": _emscripten_glTexCoord2iv, "re": _emscripten_glTexCoord2s, "qe": _emscripten_glTexCoord2sv, "pe": _emscripten_glTexCoord3d, "oe": _emscripten_glTexCoord3dv, "me": _emscripten_glTexCoord3f, "le": _emscripten_glTexCoord3fv, "ke": _emscripten_glTexCoord3i, "je": _emscripten_glTexCoord3iv, "ie": _emscripten_glTexCoord3s, "he": _emscripten_glTexCoord3sv, "ge": _emscripten_glTexCoord4d, "fe": _emscripten_glTexCoord4dv, "ee": _emscripten_glTexCoord4f, "de": _emscripten_glTexCoord4fv, "be": _emscripten_glTexCoord4i, "ae": _emscripten_glTexCoord4iv, "$d": _emscripten_glTexCoord4s, "_d": _emscripten_glTexCoord4sv, "Zd": _emscripten_glTexCoordPointer, "Yd": _emscripten_glTexEnvf, "Xd": _emscripten_glTexEnvfv, "Wd": _emscripten_glTexEnvi, "Vd": _emscripten_glTexEnviv, "Ud": _emscripten_glTexGend, "Sd": _emscripten_glTexGendv, "Rd": _emscripten_glTexGenf, "Qd": _emscripten_glTexGenfv, "Pd": _emscripten_glTexGeni, "Od": _emscripten_glTexGeniv, "Nd": _emscripten_glTexImage1D, "Md": _emscripten_glTexImage2D, "Ld": _emscripten_glTexImage3D, "Kd": _emscripten_glTexParameterIiv, "Jd": _emscripten_glTexParameterIuiv, "Hd": _emscripten_glTexParameterf, "Gd": _emscripten_glTexParameterfv, "Fd": _emscripten_glTexParameteri, "Ed": _emscripten_glTexParameteriv, "Dd": _emscripten_glTexStorage2D, "Cd": _emscripten_glTexStorage3D, "Bd": _emscripten_glTexSubImage1D, "Ad": _emscripten_glTexSubImage2D, "zd": _emscripten_glTexSubImage3D, "yd": _emscripten_glTransformFeedbackVaryings, "wd": _emscripten_glTranslated, "vd": _emscripten_glTranslatef, "ud": _emscripten_glUniform1f, "td": _emscripten_glUniform1fv, "sd": _emscripten_glUniform1i, "rd": _emscripten_glUniform1iv, "qd": _emscripten_glUniform1ui, "pd": _emscripten_glUniform1uiv, "od": _emscripten_glUniform2f, "nd": _emscripten_glUniform2fv, "ld": _emscripten_glUniform2i, "kd": _emscripten_glUniform2iv, "jd": _emscripten_glUniform2ui, "id": _emscripten_glUniform2uiv, "hd": _emscripten_glUniform3f, "gd": _emscripten_glUniform3fv, "fd": _emscripten_glUniform3i, "ed": _emscripten_glUniform3iv, "dd": _emscripten_glUniform3ui, "cd": _emscripten_glUniform3uiv, "ad": _emscripten_glUniform4f, "$c": _emscripten_glUniform4fv, "_c": _emscripten_glUniform4i, "Zc": _emscripten_glUniform4iv, "Yc": _emscripten_glUniform4ui, "Xc": _emscripten_glUniform4uiv, "Wc": _emscripten_glUniformBlockBinding, "Vc": _emscripten_glUniformMatrix2fv, "Uc": _emscripten_glUniformMatrix2x3fv, "Tc": _emscripten_glUniformMatrix2x4fv, "Rc": _emscripten_glUniformMatrix3fv, "Qc": _emscripten_glUniformMatrix3x2fv, "Pc": _emscripten_glUniformMatrix3x4fv, "Oc": _emscripten_glUniformMatrix4fv, "Nc": _emscripten_glUniformMatrix4x2fv, "Mc": _emscripten_glUniformMatrix4x3fv, "Lc": _emscripten_glUnmapBuffer, "Kc": _emscripten_glUseProgram, "Jc": _emscripten_glUseProgramObjectARB, "Ic": _emscripten_glValidateProgram, "Gc": _emscripten_glVertex2d, "Fc": _emscripten_glVertex2dv, "Ec": _emscripten_glVertex2f, "Dc": _emscripten_glVertex2fv, "Cc": _emscripten_glVertex2i, "Bc": _emscripten_glVertex2iv, "Ac": _emscripten_glVertex2s, "zc": _emscripten_glVertex2sv, "yc": _emscripten_glVertex3d, "xc": _emscripten_glVertex3dv, "vc": _emscripten_glVertex3f, "uc": _emscripten_glVertex3fv, "tc": _emscripten_glVertex3i, "sc": _emscripten_glVertex3iv, "rc": _emscripten_glVertex3s, "qc": _emscripten_glVertex3sv, "pc": _emscripten_glVertex4d, "oc": _emscripten_glVertex4dv, "nc": _emscripten_glVertex4f, "mc": _emscripten_glVertex4fv, "kc": _emscripten_glVertex4i, "jc": _emscripten_glVertex4iv, "ic": _emscripten_glVertex4s, "hc": _emscripten_glVertex4sv, "gc": _emscripten_glVertexAttrib1d, "fc": _emscripten_glVertexAttrib1dv, "ec": _emscripten_glVertexAttrib1f, "dc": _emscripten_glVertexAttrib1fv, "cc": _emscripten_glVertexAttrib1s, "bc": _emscripten_glVertexAttrib1sv, "$b": _emscripten_glVertexAttrib2d, "_b": _emscripten_glVertexAttrib2dv, "Zb": _emscripten_glVertexAttrib2f, "Yb": _emscripten_glVertexAttrib2fv, "Xb": _emscripten_glVertexAttrib2s, "Wb": _emscripten_glVertexAttrib2sv, "Vb": _emscripten_glVertexAttrib3d, "Ub": _emscripten_glVertexAttrib3dv, "Tb": _emscripten_glVertexAttrib3f, "Sb": _emscripten_glVertexAttrib3fv, "Pb": _emscripten_glVertexAttrib3s, "Ob": _emscripten_glVertexAttrib3sv, "Nb": _emscripten_glVertexAttrib4Nbv, "Mb": _emscripten_glVertexAttrib4Niv, "Lb": _emscripten_glVertexAttrib4Nsv, "Kb": _emscripten_glVertexAttrib4Nub, "Jb": _emscripten_glVertexAttrib4Nubv, "Ib": _emscripten_glVertexAttrib4Nuiv, "Hb": _emscripten_glVertexAttrib4Nusv, "Gb": _emscripten_glVertexAttrib4bv, "Eb": _emscripten_glVertexAttrib4d, "Db": _emscripten_glVertexAttrib4dv, "Cb": _emscripten_glVertexAttrib4f, "Bb": _emscripten_glVertexAttrib4fv, "Ab": _emscripten_glVertexAttrib4iv, "zb": _emscripten_glVertexAttrib4s, "yb": _emscripten_glVertexAttrib4sv, "xb": _emscripten_glVertexAttrib4ubv, "wb": _emscripten_glVertexAttrib4uiv, "vb": _emscripten_glVertexAttrib4usv, "tb": _emscripten_glVertexAttribDivisor, "sb": _emscripten_glVertexAttribI1i, "rb": _emscripten_glVertexAttribI1iv, "qb": _emscripten_glVertexAttribI1ui, "pb": _emscripten_glVertexAttribI1uiv, "ob": _emscripten_glVertexAttribI2i, "nb": _emscripten_glVertexAttribI2iv, "mb": _emscripten_glVertexAttribI2ui, "lb": _emscripten_glVertexAttribI2uiv, "kb": _emscripten_glVertexAttribI3i, "ib": _emscripten_glVertexAttribI3iv, "hb": _emscripten_glVertexAttribI3ui, "gb": _emscripten_glVertexAttribI3uiv, "fb": _emscripten_glVertexAttribI4bv, "eb": _emscripten_glVertexAttribI4i, "db": _emscripten_glVertexAttribI4iv, "cb": _emscripten_glVertexAttribI4sv, "bb": _emscripten_glVertexAttribI4ubv, "ab": _emscripten_glVertexAttribI4ui, "$a": _emscripten_glVertexAttribI4uiv, "Za": _emscripten_glVertexAttribI4usv, "Ya": _emscripten_glVertexAttribIPointer, "Xa": _emscripten_glVertexAttribPointer, "Wa": _emscripten_glVertexPointer, "Va": _emscripten_glViewport, "Ua": _emscripten_glWindowPos2d, "Ta": _emscripten_glWindowPos2dv, "Sa": _emscripten_glWindowPos2f, "Ra": _emscripten_glWindowPos2fv, "Qa": _emscripten_glWindowPos2i, "Oa": _emscripten_glWindowPos2iv, "Na": _emscripten_glWindowPos2s, "Ma": _emscripten_glWindowPos2sv, "La": _emscripten_glWindowPos3d, "Ka": _emscripten_glWindowPos3dv, "Ja": _emscripten_glWindowPos3f, "Ia": _emscripten_glWindowPos3fv, "Ha": _emscripten_glWindowPos3i, "Ga": _emscripten_glWindowPos3iv, "Fa": _emscripten_glWindowPos3s, "Da": _emscripten_glWindowPos3sv, "Ca": _emscripten_memcpy_big, "Ba": _emscripten_request_fullscreen_strategy, "P": _emscripten_request_pointerlock, "O": _emscripten_set_blur_callback_on_thread, "j": _emscripten_set_canvas_size, "p": _emscripten_set_element_css_size, "N": _emscripten_set_focus_callback_on_thread, "M": _emscripten_set_fullscreenchange_callback_on_thread, "o": _emscripten_set_gamepadconnected_callback_on_thread, "n": _emscripten_set_gamepaddisconnected_callback_on_thread, "L": _emscripten_set_keydown_callback_on_thread, "K": _emscripten_set_keypress_callback_on_thread, "J": _emscripten_set_keyup_callback_on_thread, "I": _emscripten_set_mousedown_callback_on_thread, "H": _emscripten_set_mouseenter_callback_on_thread, "G": _emscripten_set_mouseleave_callback_on_thread, "F": _emscripten_set_mousemove_callback_on_thread, "E": _emscripten_set_mouseup_callback_on_thread, "D": _emscripten_set_pointerlockchange_callback_on_thread, "C": _emscripten_set_resize_callback_on_thread, "B": _emscripten_set_touchcancel_callback_on_thread, "A": _emscripten_set_touchend_callback_on_thread, "z": _emscripten_set_touchmove_callback_on_thread, "y": _emscripten_set_touchstart_callback_on_thread, "x": _emscripten_set_visibilitychange_callback_on_thread, "w": _emscripten_set_wheel_callback_on_thread, "ya": _emscripten_sleep, "xa": _getenv, "m": _gettimeofday, "va": _glClear, "v": _llvm_stackrestore, "u": _llvm_stacksave, "ua": _localtime, "ta": _nanosleep, "g": _sigaction, "sa": _signal, "ra": _time, "a": DYNAMICTOP_PTR, "b": tempDoublePtr, "c": STACKTOP, "d": EMTSTACKTOP, "e": eb };
var asm = Module["asm"](Module.asmGlobalArg, Module.asmLibraryArg, buffer);
Module["asm"] = asm;
var ___emscripten_environ_constructor = Module["___emscripten_environ_constructor"] = (function() { return Module["asm"]["Xn"].apply(null, arguments) });
var ___errno_location = Module["___errno_location"] = (function() { return Module["asm"]["Yn"].apply(null, arguments) });
var __get_daylight = Module["__get_daylight"] = (function() { return Module["asm"]["Zn"].apply(null, arguments) });
var __get_timezone = Module["__get_timezone"] = (function() { return Module["asm"]["_n"].apply(null, arguments) });
var __get_tzname = Module["__get_tzname"] = (function() { return Module["asm"]["$n"].apply(null, arguments) });
var _emscripten_GetProcAddress = Module["_emscripten_GetProcAddress"] = (function() { return Module["asm"]["ao"].apply(null, arguments) });
var _emscripten_replace_memory = Module["_emscripten_replace_memory"] = (function() { return Module["asm"]["_emscripten_replace_memory"].apply(null, arguments) });
var _fflush = Module["_fflush"] = (function() { return Module["asm"]["bo"].apply(null, arguments) });
var _free = Module["_free"] = (function() { return Module["asm"]["co"].apply(null, arguments) });
var _main = Module["_main"] = (function() { return Module["asm"]["eo"].apply(null, arguments) });
var _malloc = Module["_malloc"] = (function() { return Module["asm"]["fo"].apply(null, arguments) });
var emtStackRestore = Module["emtStackRestore"] = (function() { return Module["asm"]["ep"].apply(null, arguments) });
var emtStackSave = Module["emtStackSave"] = (function() { return Module["asm"]["fp"].apply(null, arguments) });
var emterpret = Module["emterpret"] = (function() { return Module["asm"]["gp"].apply(null, arguments) });
var setAsyncState = Module["setAsyncState"] = (function() { return Module["asm"]["hp"].apply(null, arguments) });
var stackAlloc = Module["stackAlloc"] = (function() { return Module["asm"]["ip"].apply(null, arguments) });
var stackRestore = Module["stackRestore"] = (function() { return Module["asm"]["jp"].apply(null, arguments) });
var stackSave = Module["stackSave"] = (function() { return Module["asm"]["kp"].apply(null, arguments) });
var dynCall_i = Module["dynCall_i"] = (function() { return Module["asm"]["go"].apply(null, arguments) });
var dynCall_ii = Module["dynCall_ii"] = (function() { return Module["asm"]["ho"].apply(null, arguments) });
var dynCall_iii = Module["dynCall_iii"] = (function() { return Module["asm"]["io"].apply(null, arguments) });
var dynCall_iiii = Module["dynCall_iiii"] = (function() { return Module["asm"]["jo"].apply(null, arguments) });
var dynCall_iiiii = Module["dynCall_iiiii"] = (function() { return Module["asm"]["ko"].apply(null, arguments) });
var dynCall_iiiiidii = Module["dynCall_iiiiidii"] = (function() { return Module["asm"]["lo"].apply(null, arguments) });
var dynCall_iiiiii = Module["dynCall_iiiiii"] = (function() { return Module["asm"]["mo"].apply(null, arguments) });
var dynCall_iiiiiiii = Module["dynCall_iiiiiiii"] = (function() { return Module["asm"]["no"].apply(null, arguments) });
var dynCall_iiiiiiiii = Module["dynCall_iiiiiiiii"] = (function() { return Module["asm"]["oo"].apply(null, arguments) });
var dynCall_iiiiiiiiii = Module["dynCall_iiiiiiiiii"] = (function() { return Module["asm"]["po"].apply(null, arguments) });
var dynCall_v = Module["dynCall_v"] = (function() { return Module["asm"]["qo"].apply(null, arguments) });
var dynCall_vd = Module["dynCall_vd"] = (function() { return Module["asm"]["ro"].apply(null, arguments) });
var dynCall_vdd = Module["dynCall_vdd"] = (function() { return Module["asm"]["so"].apply(null, arguments) });
var dynCall_vddd = Module["dynCall_vddd"] = (function() { return Module["asm"]["to"].apply(null, arguments) });
var dynCall_vdddd = Module["dynCall_vdddd"] = (function() { return Module["asm"]["uo"].apply(null, arguments) });
var dynCall_vdddddd = Module["dynCall_vdddddd"] = (function() { return Module["asm"]["vo"].apply(null, arguments) });
var dynCall_vf = Module["dynCall_vf"] = (function() { return Module["asm"]["wo"].apply(null, arguments) });
var dynCall_vff = Module["dynCall_vff"] = (function() { return Module["asm"]["xo"].apply(null, arguments) });
var dynCall_vfff = Module["dynCall_vfff"] = (function() { return Module["asm"]["yo"].apply(null, arguments) });
var dynCall_vffff = Module["dynCall_vffff"] = (function() { return Module["asm"]["zo"].apply(null, arguments) });
var dynCall_vfi = Module["dynCall_vfi"] = (function() { return Module["asm"]["Ao"].apply(null, arguments) });
var dynCall_vi = Module["dynCall_vi"] = (function() { return Module["asm"]["Bo"].apply(null, arguments) });
var dynCall_vid = Module["dynCall_vid"] = (function() { return Module["asm"]["Co"].apply(null, arguments) });
var dynCall_vidd = Module["dynCall_vidd"] = (function() { return Module["asm"]["Do"].apply(null, arguments) });
var dynCall_viddd = Module["dynCall_viddd"] = (function() { return Module["asm"]["Eo"].apply(null, arguments) });
var dynCall_vidddd = Module["dynCall_vidddd"] = (function() { return Module["asm"]["Fo"].apply(null, arguments) });
var dynCall_viddidd = Module["dynCall_viddidd"] = (function() { return Module["asm"]["Go"].apply(null, arguments) });
var dynCall_viddiiddiii = Module["dynCall_viddiiddiii"] = (function() { return Module["asm"]["Ho"].apply(null, arguments) });
var dynCall_viddiii = Module["dynCall_viddiii"] = (function() { return Module["asm"]["Io"].apply(null, arguments) });
var dynCall_vif = Module["dynCall_vif"] = (function() { return Module["asm"]["Jo"].apply(null, arguments) });
var dynCall_viff = Module["dynCall_viff"] = (function() { return Module["asm"]["Ko"].apply(null, arguments) });
var dynCall_vifff = Module["dynCall_vifff"] = (function() { return Module["asm"]["Lo"].apply(null, arguments) });
var dynCall_viffff = Module["dynCall_viffff"] = (function() { return Module["asm"]["Mo"].apply(null, arguments) });
var dynCall_viffiff = Module["dynCall_viffiff"] = (function() { return Module["asm"]["No"].apply(null, arguments) });
var dynCall_viffiiffiii = Module["dynCall_viffiiffiii"] = (function() { return Module["asm"]["Oo"].apply(null, arguments) });
var dynCall_viffiii = Module["dynCall_viffiii"] = (function() { return Module["asm"]["Po"].apply(null, arguments) });
var dynCall_vii = Module["dynCall_vii"] = (function() { return Module["asm"]["Qo"].apply(null, arguments) });
var dynCall_viid = Module["dynCall_viid"] = (function() { return Module["asm"]["Ro"].apply(null, arguments) });
var dynCall_viidddd = Module["dynCall_viidddd"] = (function() { return Module["asm"]["So"].apply(null, arguments) });
var dynCall_viif = Module["dynCall_viif"] = (function() { return Module["asm"]["To"].apply(null, arguments) });
var dynCall_viiffff = Module["dynCall_viiffff"] = (function() { return Module["asm"]["Uo"].apply(null, arguments) });
var dynCall_viiffffi = Module["dynCall_viiffffi"] = (function() { return Module["asm"]["Vo"].apply(null, arguments) });
var dynCall_viifi = Module["dynCall_viifi"] = (function() { return Module["asm"]["Wo"].apply(null, arguments) });
var dynCall_viii = Module["dynCall_viii"] = (function() { return Module["asm"]["Xo"].apply(null, arguments) });
var dynCall_viiii = Module["dynCall_viiii"] = (function() { return Module["asm"]["Yo"].apply(null, arguments) });
var dynCall_viiiii = Module["dynCall_viiiii"] = (function() { return Module["asm"]["Zo"].apply(null, arguments) });
var dynCall_viiiiii = Module["dynCall_viiiiii"] = (function() { return Module["asm"]["_o"].apply(null, arguments) });
var dynCall_viiiiiii = Module["dynCall_viiiiiii"] = (function() { return Module["asm"]["$o"].apply(null, arguments) });
var dynCall_viiiiiiii = Module["dynCall_viiiiiiii"] = (function() { return Module["asm"]["ap"].apply(null, arguments) });
var dynCall_viiiiiiiii = Module["dynCall_viiiiiiiii"] = (function() { return Module["asm"]["bp"].apply(null, arguments) });
var dynCall_viiiiiiiiii = Module["dynCall_viiiiiiiiii"] = (function() { return Module["asm"]["cp"].apply(null, arguments) });
var dynCall_viiiiiiiiiii = Module["dynCall_viiiiiiiiiii"] = (function() { return Module["asm"]["dp"].apply(null, arguments) });
Module["asm"] = asm;
Module["ccall"] = ccall;
Module["Pointer_stringify"] = Pointer_stringify;
Module["addOnExit"] = addOnExit;

function ExitStatus(status) {
    this.name = "ExitStatus";
    this.message = "Program terminated with exit(" + status + ")";
    this.status = status
}
ExitStatus.prototype = new Error;
ExitStatus.prototype.constructor = ExitStatus;
var initialStackTop;
var calledMain = false;
dependenciesFulfilled = function runCaller() { if (!Module["calledRun"]) run(); if (!Module["calledRun"]) dependenciesFulfilled = runCaller };
Module["callMain"] = function callMain(args) {
    args = args || [];
    ensureInitRuntime();
    var argc = args.length + 1;
    var argv = stackAlloc((argc + 1) * 4);
    HEAP32[argv >> 2] = allocateUTF8OnStack(Module["thisProgram"]);
    for (var i = 1; i < argc; i++) { HEAP32[(argv >> 2) + i] = allocateUTF8OnStack(args[i - 1]) }
    HEAP32[(argv >> 2) + argc] = 0;
    var initialEmtStackTop = Module["emtStackSave"]();
    try { var ret = Module["_main"](argc, argv, 0); if (typeof EmterpreterAsync === "object" && EmterpreterAsync.state !== 1) { exit(ret, true) } } catch (e) {
        if (e instanceof ExitStatus) { return } else if (e == "SimulateInfiniteLoop") {
            Module["noExitRuntime"] = true;
            Module["emtStackRestore"](initialEmtStackTop);
            return
        } else {
            var toLog = e;
            if (e && typeof e === "object" && e.stack) { toLog = [e, e.stack] }
            err("exception thrown: " + toLog);
            Module["quit"](1, e)
        }
    } finally { calledMain = true }
};

function run(args) {
    args = args || Module["arguments"];
    if (runDependencies > 0) { return }
    preRun();
    if (runDependencies > 0) return;
    if (Module["calledRun"]) return;

    function doRun() {
        if (Module["calledRun"]) return;
        Module["calledRun"] = true;
        if (ABORT) return;
        ensureInitRuntime();
        preMain();
        if (Module["onRuntimeInitialized"]) Module["onRuntimeInitialized"]();
        if (Module["_main"] && shouldRunNow) Module["callMain"](args);
        postRun()
    }
    if (Module["setStatus"]) {
        Module["setStatus"]("Running...");
        setTimeout((function() {
            setTimeout((function() { Module["setStatus"]("") }), 1);
            doRun()
        }), 1)
    } else { doRun() }
}
Module["run"] = run;

function exit(status, implicit) {
    if (implicit && Module["noExitRuntime"] && status === 0) { return }
    if (Module["noExitRuntime"]) {} else {
        ABORT = true;
        EXITSTATUS = status;
        STACKTOP = initialStackTop;
        exitRuntime();
        if (Module["onExit"]) Module["onExit"](status)
    }
    Module["quit"](status, new ExitStatus(status))
}

function abort(what) {
    if (Module["onAbort"]) { Module["onAbort"](what) }
    if (what !== undefined) {
        out(what);
        err(what);
        what = JSON.stringify(what)
    } else { what = "" }
    ABORT = true;
    EXITSTATUS = 1;
    throw "abort(" + what + "). Build with -s ASSERTIONS=1 for more info."
}
Module["abort"] = abort;
if (Module["preInit"]) { if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]]; while (Module["preInit"].length > 0) { Module["preInit"].pop()() } }
var shouldRunNow = true;
if (Module["noInitialRun"]) { shouldRunNow = false }
run();
if (typeof window === "object" && (typeof ENVIRONMENT_IS_PTHREAD === "undefined" || !ENVIRONMENT_IS_PTHREAD)) {
    function emrun_register_handlers() {
        var emrun_num_post_messages_in_flight = 0;
        var emrun_should_close_itself = false;

        function postExit(msg) {
            var http = new XMLHttpRequest;
            http.onreadystatechange = (function() { if (http.readyState == 4) { try { if (typeof window !== "undefined" && window.close) window.close() } catch (e) {} } });
            http.open("POST", "stdio.html", true);
            http.send(msg)
        }

        function post(msg) {
            var http = new XMLHttpRequest;
            ++emrun_num_post_messages_in_flight;
            http.onreadystatechange = (function() { if (http.readyState == 4) { if (--emrun_num_post_messages_in_flight == 0 && emrun_should_close_itself) postExit("^exit^" + EXITSTATUS) } });
            http.open("POST", "stdio.html", true);
            http.send(msg)
        }
        if (document.URL.search("localhost") != -1 || document.URL.search(":6931/") != -1) {
            var emrun_http_sequence_number = 1;
            var prevPrint = out;
            var prevErr = err;

            function emrun_exit() {
                if (emrun_num_post_messages_in_flight == 0) postExit("^exit^" + EXITSTATUS);
                else emrun_should_close_itself = true
            }
            Module["addOnExit"](emrun_exit);
            out = function emrun_print(text) {
                post("^out^" + emrun_http_sequence_number++ + "^" + encodeURIComponent(text));
                prevPrint(text)
            };
            err = function emrun_printErr(text) {
                post("^err^" + emrun_http_sequence_number++ + "^" + encodeURIComponent(text));
                prevErr(text)
            };
            post("^pageload^")
        }
    }
    if (typeof Module !== "undefined" && typeof document !== "undefined") emrun_register_handlers()
}