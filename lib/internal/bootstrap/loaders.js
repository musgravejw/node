// This file creates the internal module & binding loaders used by built-in
// modules. In contrast, user land modules are loaded using
// lib/internal/modules/cjs/loader.js (CommonJS Modules) or
// lib/internal/modules/esm/* (ES Modules).
//
// This file is compiled and run by node.cc before bootstrap/node.js
// was called, therefore the loaders are bootstraped before we start to
// actually bootstrap Node.js. It creates the following objects:
//
// C++ binding loaders:
// - process.binding(): the legacy C++ binding loader, accessible from user land
//   because it is an object attached to the global process object.
//   These C++ bindings are created using NODE_BUILTIN_MODULE_CONTEXT_AWARE()
//   and have their nm_flags set to NM_F_BUILTIN. We do not make any guarantees
//   about the stability of these bindings, but still have to take care of
//   compatibility issues caused by them from time to time.
// - process._linkedBinding(): intended to be used by embedders to add
//   additional C++ bindings in their applications. These C++ bindings
//   can be created using NODE_MODULE_CONTEXT_AWARE_CPP() with the flag
//   NM_F_LINKED.
// - internalBinding(): the private internal C++ binding loader, inaccessible
//   from user land because they are only available from NativeModule.require()
//   These C++ bindings are created using NODE_MODULE_CONTEXT_AWARE_INTERNAL()
//   and have their nm_flags set to NM_F_INTERNAL.
//
// Internal JavaScript module loader:
// - NativeModule: a minimal module system used to load the JavaScript core
//   modules found in lib/**/*.js and deps/**/*.js. All core modules are
//   compiled into the node binary via node_javascript.cc generated by js2c.py,
//   so they can be loaded faster without the cost of I/O. This class makes the
//   lib/internal/*, deps/internal/* modules and internalBinding() available by
//   default to core modules, and lets the core modules require itself via
//   require('internal/bootstrap/loaders') even when this file is not written in
//   CommonJS style.
//
// Other objects:
// - process.moduleLoadList: an array recording the bindings and the modules
//   loaded in the process and the order in which they are loaded.

'use strict';

(function bootstrapInternalLoaders(process, getBinding, getLinkedBinding,
                                   getInternalBinding) {

  // Set up process.moduleLoadList
  const moduleLoadList = [];
  Object.defineProperty(process, 'moduleLoadList', {
    value: moduleLoadList,
    configurable: true,
    enumerable: true,
    writable: false
  });

  // Set up process.binding() and process._linkedBinding()
  {
    const bindingObj = Object.create(null);

    process.binding = function binding(module) {
      module = String(module);
      let mod = bindingObj[module];
      if (typeof mod !== 'object') {
        mod = bindingObj[module] = getBinding(module);
        moduleLoadList.push(`Binding ${module}`);
      }
      return mod;
    };

    process._linkedBinding = function _linkedBinding(module) {
      module = String(module);
      let mod = bindingObj[module];
      if (typeof mod !== 'object')
        mod = bindingObj[module] = getLinkedBinding(module);
      return mod;
    };
  }

  // Set up internalBinding() in the closure
  let internalBinding;
  {
    const bindingObj = Object.create(null);
    internalBinding = function internalBinding(module) {
      let mod = bindingObj[module];
      if (typeof mod !== 'object') {
        mod = bindingObj[module] = getInternalBinding(module);
        moduleLoadList.push(`Internal Binding ${module}`);
      }
      return mod;
    };
  }

  const ContextifyScript = process.binding('contextify').ContextifyScript;

  // Set up NativeModule
  function NativeModule(id) {
    this.filename = `${id}.js`;
    this.id = id;
    this.exports = {};
    this.loaded = false;
    this.loading = false;
  }

  NativeModule._source = getBinding('natives');
  NativeModule._cache = {};

  const config = getBinding('config');

  // Think of this as module.exports in this file even though it is not
  // written in CommonJS style.
  const loaderExports = { internalBinding, NativeModule };
  const loaderId = 'internal/bootstrap/loaders';
  NativeModule.require = function(id) {
    if (id === loaderId) {
      return loaderExports;
    }

    const cached = NativeModule.getCached(id);
    if (cached && (cached.loaded || cached.loading)) {
      return cached.exports;
    }

    if (!NativeModule.exists(id)) {
      // Model the error off the internal/errors.js model, but
      // do not use that module given that it could actually be
      // the one causing the error if there's a bug in Node.js
      // eslint-disable-next-line no-restricted-syntax
      const err = new Error(`No such built-in module: ${id}`);
      err.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
      err.name = 'Error [ERR_UNKNOWN_BUILTIN_MODULE]';
      throw err;
    }

    moduleLoadList.push(`NativeModule ${id}`);

    const nativeModule = new NativeModule(id);

    nativeModule.cache();
    nativeModule.compile();

    return nativeModule.exports;
  };

  NativeModule.requireForDeps = function(id) {
    if (!NativeModule.exists(id) ||
        // TODO(TimothyGu): remove when DEP0084 reaches end of life.
        id.startsWith('node-inspect/') ||
        id.startsWith('v8/')) {
      id = `internal/deps/${id}`;
    }
    return NativeModule.require(id);
  };

  NativeModule.getCached = function(id) {
    return NativeModule._cache[id];
  };

  NativeModule.exists = function(id) {
    return NativeModule._source.hasOwnProperty(id);
  };

  if (config.exposeInternals) {
    NativeModule.nonInternalExists = function(id) {
      // Do not expose this to user land even with --expose-internals
      if (id === loaderId) {
        return false;
      }
      return NativeModule.exists(id);
    };

    NativeModule.isInternal = function(id) {
      // Do not expose this to user land even with --expose-internals
      return id === loaderId;
    };
  } else {
    NativeModule.nonInternalExists = function(id) {
      return NativeModule.exists(id) && !NativeModule.isInternal(id);
    };

    NativeModule.isInternal = function(id) {
      return id.startsWith('internal/');
    };
  }

  NativeModule.getSource = function(id) {
    return NativeModule._source[id];
  };

  NativeModule.wrap = function(script) {
    return NativeModule.wrapper[0] + script + NativeModule.wrapper[1];
  };

  NativeModule.wrapper = [
    '(function (exports, require, module, process) {',
    '\n});'
  ];

  NativeModule.prototype.compile = function() {
    let source = NativeModule.getSource(this.id);
    source = NativeModule.wrap(source);

    this.loading = true;

    try {
      const script = new ContextifyScript(source, this.filename);
      // Arguments: timeout, displayErrors, breakOnSigint
      const fn = script.runInThisContext(-1, true, false);
      const requireFn = this.id.startsWith('internal/deps/') ?
        NativeModule.requireForDeps :
        NativeModule.require;
      fn(this.exports, requireFn, this, process);

      this.loaded = true;
    } finally {
      this.loading = false;
    }
  };

  NativeModule.prototype.cache = function() {
    NativeModule._cache[this.id] = this;
  };

  // This will be passed to the bootstrapNodeJSCore function in
  // bootstrap/node.js.
  return loaderExports;
});
