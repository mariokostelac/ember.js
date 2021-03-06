import {
  didRender,
  get,
  getCurrentTracker,
  set,
  setCurrentTracker,
  tagFor,
  tagForProperty,
  watchKey,
} from '@ember/-internals/metal';
import { isProxy, symbol } from '@ember/-internals/utils';
import { EMBER_METAL_TRACKED_PROPERTIES } from '@ember/canary-features';
import { DEBUG } from '@glimmer/env';
import { Opaque } from '@glimmer/interfaces';
import {
  combine,
  CONSTANT_TAG,
  ConstReference,
  DirtyableTag,
  isConst,
  Revision,
  RevisionTag,
  Tag,
  TagWrapper,
  UpdatableTag,
  VersionedPathReference,
  VersionedReference,
} from '@glimmer/reference';
import {
  CapturedArguments,
  ConditionalReference as GlimmerConditionalReference,
  PrimitiveReference,
} from '@glimmer/runtime';
import { Option, unreachable } from '@glimmer/util';
import { HelperFunction, HelperInstance, RECOMPUTE_TAG } from '../helper';
import emberToBool from './to-bool';

export const UPDATE = symbol('UPDATE');
export const INVOKE = symbol('INVOKE');
export const ACTION = symbol('ACTION');

let maybeFreeze: (obj: any) => void;
if (DEBUG) {
  // gaurding this in a DEBUG gaurd (as well as all invocations)
  // so that it is properly stripped during the minification's
  // dead code elimination
  maybeFreeze = (obj: any) => {
    // re-freezing an already frozen object introduces a significant
    // performance penalty on Chrome (tested through 59).
    //
    // See: https://bugs.chromium.org/p/v8/issues/detail?id=6450
    if (!Object.isFrozen(obj)) {
      Object.freeze(obj);
    }
  };
}

abstract class EmberPathReference implements VersionedPathReference<Opaque> {
  abstract tag: Tag;

  get(key: string): any {
    return PropertyReference.create(this, key);
  }

  abstract value(): Opaque;
}

export abstract class CachedReference extends EmberPathReference {
  abstract tag: Tag;
  private _lastRevision: Option<Revision>;
  private _lastValue: Opaque;

  constructor() {
    super();
    this._lastRevision = null;
    this._lastValue = null;
  }

  abstract compute(): Opaque;

  value() {
    let { tag, _lastRevision, _lastValue } = this;

    if (_lastRevision === null || !tag.validate(_lastRevision)) {
      _lastValue = this._lastValue = this.compute();
      this._lastRevision = tag.value();
    }

    return _lastValue;
  }
}

export class RootReference<T> extends ConstReference<T> {
  public children: any;

  constructor(value: T) {
    super(value);
    this.children = Object.create(null);
  }

  get(propertyKey: string) {
    let ref = this.children[propertyKey];

    if (ref === undefined) {
      ref = this.children[propertyKey] = new RootPropertyReference(this.inner, propertyKey);
    }

    return ref;
  }
}

interface TwoWayFlushDetectionTag extends RevisionTag {
  didCompute(parent: Opaque): void;
}

let TwoWayFlushDetectionTag: {
  new (tag: Tag, key: string, ref: VersionedPathReference<Opaque>): TwoWayFlushDetectionTag;
  create(
    tag: Tag,
    key: string,
    ref: VersionedPathReference<Opaque>
  ): TagWrapper<TwoWayFlushDetectionTag>;
};

if (DEBUG) {
  TwoWayFlushDetectionTag = class {
    public tag: Tag;
    public parent: Opaque;
    public key: string;
    public ref: any;

    static create(
      tag: Tag,
      key: string,
      ref: VersionedPathReference<Opaque>
    ): TagWrapper<TwoWayFlushDetectionTag> {
      return new TagWrapper((tag as any).type, new TwoWayFlushDetectionTag(tag, key, ref));
    }

    constructor(tag: Tag, key: string, ref: any) {
      this.tag = tag;
      this.parent = null;
      this.key = key;
      this.ref = ref;
    }

    value() {
      return this.tag.value();
    }

    validate(ticket: any) {
      let { parent, key } = this;

      let isValid = this.tag.validate(ticket);

      if (isValid && parent) {
        didRender(parent, key, this.ref);
      }

      return isValid;
    }

    didCompute(parent: any) {
      this.parent = parent;
      didRender(parent, this.key, this.ref);
    }
  };
}

export abstract class PropertyReference extends CachedReference {
  abstract tag: Tag;

  static create(parentReference: VersionedPathReference<Opaque>, propertyKey: string) {
    if (isConst(parentReference)) {
      return new RootPropertyReference(parentReference.value(), propertyKey);
    } else {
      return new NestedPropertyReference(parentReference, propertyKey);
    }
  }

  get(key: string): VersionedPathReference<Opaque> {
    return new NestedPropertyReference(this, key);
  }
}

export class RootPropertyReference extends PropertyReference
  implements VersionedPathReference<Opaque> {
  public tag: Tag;
  private _parentValue: any;
  private _propertyKey: string;
  private _propertyTag: TagWrapper<UpdatableTag>;

  constructor(parentValue: any, propertyKey: string) {
    super();

    this._parentValue = parentValue;
    this._propertyKey = propertyKey;

    if (EMBER_METAL_TRACKED_PROPERTIES) {
      this._propertyTag = UpdatableTag.create(CONSTANT_TAG);
    } else {
      this._propertyTag = UpdatableTag.create(tagForProperty(parentValue, propertyKey));
    }

    if (DEBUG) {
      this.tag = TwoWayFlushDetectionTag.create(this._propertyTag, propertyKey, this);
    } else {
      this.tag = this._propertyTag;
    }

    if (DEBUG) {
      watchKey(parentValue, propertyKey);
    }
  }

  compute() {
    let { _parentValue, _propertyKey } = this;

    if (DEBUG) {
      (this.tag.inner as TwoWayFlushDetectionTag).didCompute(_parentValue);
    }

    let parent: any;
    let tracker: any;

    if (EMBER_METAL_TRACKED_PROPERTIES) {
      parent = getCurrentTracker();
      tracker = setCurrentTracker();
    }

    let ret = get(_parentValue, _propertyKey);

    if (EMBER_METAL_TRACKED_PROPERTIES) {
      setCurrentTracker(parent!);
      let tag = tracker!.combine();
      if (parent) parent.add(tag);

      this._propertyTag.inner.update(tag);
    }

    return ret;
  }

  [UPDATE](value: any) {
    set(this._parentValue, this._propertyKey, value);
  }
}

export class NestedPropertyReference extends PropertyReference {
  public tag: Tag;
  private _parentReference: any;
  private _propertyTag: TagWrapper<UpdatableTag>;
  private _propertyKey: string;

  constructor(parentReference: VersionedPathReference<Opaque>, propertyKey: string) {
    super();

    let parentReferenceTag = parentReference.tag;
    let propertyTag = UpdatableTag.create(CONSTANT_TAG);

    this._parentReference = parentReference;
    this._propertyTag = propertyTag;
    this._propertyKey = propertyKey;

    if (DEBUG) {
      let tag = combine([parentReferenceTag, propertyTag]);
      this.tag = TwoWayFlushDetectionTag.create(tag, propertyKey, this);
    } else {
      this.tag = combine([parentReferenceTag, propertyTag]);
    }
  }

  compute() {
    let { _parentReference, _propertyTag, _propertyKey } = this;

    let parentValue = _parentReference.value();
    let parentValueType = typeof parentValue;

    if (parentValueType === 'string' && _propertyKey === 'length') {
      return parentValue.length;
    }

    if ((parentValueType === 'object' && parentValue !== null) || parentValueType === 'function') {
      if (DEBUG) {
        watchKey(parentValue, _propertyKey);
      }

      if (DEBUG) {
        (this.tag.inner as TwoWayFlushDetectionTag).didCompute(parentValue);
      }

      let parent: any;
      let tracker: any;

      if (EMBER_METAL_TRACKED_PROPERTIES) {
        parent = getCurrentTracker();
        tracker = setCurrentTracker();
      }

      let ret = get(parentValue, _propertyKey);

      if (EMBER_METAL_TRACKED_PROPERTIES) {
        setCurrentTracker(parent!);
        let tag = tracker!.combine();
        if (parent) parent.add(tag);

        _propertyTag.inner.update(tag);
      } else {
        _propertyTag.inner.update(tagForProperty(parentValue, _propertyKey));
      }

      return ret;
    } else {
      return undefined;
    }
  }

  [UPDATE](value: any) {
    let parent = this._parentReference.value();
    set(parent, this._propertyKey, value);
  }
}

export class UpdatableReference extends EmberPathReference {
  public tag: TagWrapper<DirtyableTag>;
  private _value: any;

  constructor(value: any) {
    super();

    this.tag = DirtyableTag.create();
    this._value = value;
  }

  value() {
    return this._value;
  }

  update(value: any) {
    let { _value } = this;

    if (value !== _value) {
      this.tag.inner.dirty();
      this._value = value;
    }
  }
}

export class ConditionalReference extends GlimmerConditionalReference
  implements VersionedReference<boolean> {
  public objectTag: TagWrapper<UpdatableTag>;
  static create(reference: VersionedReference<Opaque>): VersionedReference<boolean> {
    if (isConst(reference)) {
      let value = reference.value();

      if (isProxy(value)) {
        return new RootPropertyReference(value, 'isTruthy') as VersionedReference<any>;
      } else {
        return PrimitiveReference.create(emberToBool(value));
      }
    }

    return new ConditionalReference(reference);
  }

  constructor(reference: VersionedReference<Opaque>) {
    super(reference);
    this.objectTag = UpdatableTag.create(CONSTANT_TAG);
    this.tag = combine([reference.tag, this.objectTag]);
  }

  toBool(predicate: Opaque) {
    if (isProxy(predicate)) {
      this.objectTag.inner.update(tagForProperty(predicate, 'isTruthy'));
      return get(predicate as object, 'isTruthy');
    } else {
      this.objectTag.inner.update(tagFor(predicate));
      return emberToBool(predicate);
    }
  }
}

export class SimpleHelperReference extends CachedReference {
  public tag: Tag;
  public helper: HelperFunction;
  public args: CapturedArguments;

  static create(helper: HelperFunction, args: CapturedArguments) {
    if (isConst(args)) {
      let { positional, named } = args;

      let positionalValue = positional.value();
      let namedValue = named.value();

      if (DEBUG) {
        maybeFreeze(positionalValue);
        maybeFreeze(namedValue);
      }

      let result = helper(positionalValue, namedValue);
      return valueToRef(result);
    } else {
      return new SimpleHelperReference(helper, args);
    }
  }

  constructor(helper: HelperFunction, args: CapturedArguments) {
    super();

    this.tag = args.tag;
    this.helper = helper;
    this.args = args;
  }

  compute() {
    let {
      helper,
      args: { positional, named },
    } = this;

    let positionalValue = positional.value();
    let namedValue = named.value();

    if (DEBUG) {
      maybeFreeze(positionalValue);
      maybeFreeze(namedValue);
    }

    return helper(positionalValue, namedValue);
  }
}

export class ClassBasedHelperReference extends CachedReference {
  public tag: Tag;
  public instance: HelperInstance;
  public args: CapturedArguments;

  static create(instance: HelperInstance, args: CapturedArguments) {
    return new ClassBasedHelperReference(instance, args);
  }

  constructor(instance: HelperInstance, args: CapturedArguments) {
    super();

    this.tag = combine([instance[RECOMPUTE_TAG], args.tag]);
    this.instance = instance;
    this.args = args;
  }

  compute() {
    let {
      instance,
      args: { positional, named },
    } = this;

    let positionalValue = positional.value();
    let namedValue = named.value();

    if (DEBUG) {
      maybeFreeze(positionalValue);
      maybeFreeze(namedValue);
    }

    return instance.compute(positionalValue, namedValue);
  }
}

export class InternalHelperReference extends CachedReference {
  public tag: Tag;
  public helper: (args: CapturedArguments) => CapturedArguments;
  public args: any;

  constructor(helper: (args: CapturedArguments) => any, args: CapturedArguments) {
    super();

    this.tag = args.tag;
    this.helper = helper;
    this.args = args;
  }

  compute() {
    let { helper, args } = this;
    return helper(args);
  }
}

export class UnboundReference<T> extends ConstReference<T> {
  static create<T>(value: T): VersionedPathReference<T> {
    return valueToRef(value, false);
  }

  get(key: string) {
    return valueToRef(get(this.inner as any, key), false);
  }
}

export class ReadonlyReference extends CachedReference {
  constructor(private inner: VersionedPathReference<Opaque>) {
    super();
  }

  get tag() {
    return this.inner.tag;
  }

  get [INVOKE]() {
    return this.inner[INVOKE];
  }

  compute() {
    return this.inner.value();
  }

  get(key: string) {
    return this.inner.get(key);
  }
}

export function referenceFromParts(
  root: VersionedPathReference<Opaque>,
  parts: string[]
): VersionedPathReference<Opaque> {
  let reference = root;

  for (let i = 0; i < parts.length; i++) {
    reference = reference.get(parts[i]);
  }

  return reference;
}

type Primitive = undefined | null | boolean | number | string;

function isObject(value: Opaque): value is object {
  return value !== null && typeof value === 'object';
}

function isFunction(value: Opaque): value is Function {
  return typeof value === 'function';
}

function isPrimitive(value: Opaque): value is Primitive {
  if (DEBUG) {
    let type = typeof value;
    return (
      value === undefined ||
      value === null ||
      type === 'boolean' ||
      type === 'number' ||
      type === 'string'
    );
  } else {
    return true;
  }
}

export function valueToRef<T = Opaque>(value: T, bound = true): VersionedPathReference<T> {
  if (isObject(value)) {
    // root of interop with ember objects
    return bound ? new RootReference(value) : new UnboundReference(value);
  } else if (isFunction(value)) {
    // ember doesn't do observing with functions
    return new UnboundReference(value);
  } else if (isPrimitive(value)) {
    return PrimitiveReference.create(value);
  } else if (DEBUG) {
    let type = typeof value;
    let output: Option<string>;

    try {
      output = String(value);
    } catch (e) {
      output = null;
    }

    if (output) {
      throw unreachable(`[BUG] Unexpected ${type} (${output})`);
    } else {
      throw unreachable(`[BUG] Unexpected ${type}`);
    }
  } else {
    throw unreachable();
  }
}
