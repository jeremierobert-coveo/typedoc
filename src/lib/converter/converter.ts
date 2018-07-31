import * as ts from 'typescript';
import * as _ts from '../ts-internal';
import * as _ from 'lodash';
import * as Path from 'path';

import { Application } from '../application';
import { ParameterType } from '../utils/options/declaration';
import { Reflection, Type, ProjectReflection } from '../models/index';
import { Context } from './context';
import { ConverterComponent, ConverterNodeComponent, ConverterTypeComponent, TypeTypeConverter, TypeNodeConverter } from './components';
import { CompilerHost } from './utils/compiler-host';
import { Component, Option, ChildableComponent, ComponentClass } from '../utils/component';
import { normalizePath } from '../utils/fs';
import { getRawComment, parseComment } from './factories/comment';
import { CommentTag } from '../models/comments';
import { ReflectionFlag, DeclarationReflection, ReflectionKind } from '../..';

/**
 * Result structure of the [[Converter.convert]] method.
 */
export interface ConverterResult {
    /**
     * An array containing all errors generated by the TypeScript compiler.
     */
    errors: ReadonlyArray<ts.Diagnostic>;

    /**
     * The resulting project reflection.
     */
    project: ProjectReflection;
}

/**
 * Compiles source files using TypeScript and converts compiler symbols to reflections.
 */
@Component({name: 'converter', internal: true, childClass: ConverterComponent})
export class Converter extends ChildableComponent<Application, ConverterComponent> {
    /**
     * The human readable name of the project. Used within the templates to set the title of the document.
     */
    @Option({
        name: 'name',
        help: 'Set the name of the project that will be used in the header of the template.'
    })
    name: string;

    @Option({
        name: 'externalPattern',
        help: 'Define a pattern for files that should be considered being external.'
    })
    externalPattern: string;

    @Option({
        name: 'includeDeclarations',
        help: 'Turn on parsing of .d.ts declaration files.',
        type: ParameterType.Boolean
    })
    includeDeclarations: boolean;

    @Option({
        name: 'excludeExternals',
        help: 'Prevent externally resolved TypeScript files from being documented.',
        type: ParameterType.Boolean
    })
    excludeExternals: boolean;

    @Option({
        name: 'excludeNotExported',
        help: 'Prevent symbols that are not exported from being documented.',
        type: ParameterType.Boolean
    })
    excludeNotExported: boolean;

    @Option({
        name: 'excludePrivate',
        help: 'Ignores private variables and methods',
        type: ParameterType.Boolean
    })
    excludePrivate: boolean;

    @Option({
        name: 'excludeProtected',
        help: 'Ignores protected variables and methods',
        type: ParameterType.Boolean
    })
    excludeProtected: boolean;

    public compilerHost: CompilerHost;

    private nodeConverters: {[syntaxKind: number]: ConverterNodeComponent<ts.Node>};

    private typeNodeConverters: TypeNodeConverter<ts.Type, ts.Node>[];

    private typeTypeConverters: TypeTypeConverter<ts.Type>[];

    /**
     * General events
     */

    /**
     * Triggered when the converter begins converting a project.
     * The listener should implement [[IConverterCallback]].
     * @event
     */
    static EVENT_BEGIN = 'begin';

    /**
     * Triggered when the converter has finished converting a project.
     * The listener should implement [[IConverterCallback]].
     * @event
     */
    static EVENT_END = 'end';

    /**
     * Factory events
     */

    /**
     * Triggered when the converter begins converting a source file.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_FILE_BEGIN = 'fileBegin';

    /**
     * Triggered when the converter has created a declaration reflection.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_CREATE_DECLARATION = 'createDeclaration';

    /**
     * Triggered when the converter has created a signature reflection.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_CREATE_SIGNATURE = 'createSignature';

    /**
     * Triggered when the converter has created a parameter reflection.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_CREATE_PARAMETER = 'createParameter';

    /**
     * Triggered when the converter has created a type parameter reflection.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_CREATE_TYPE_PARAMETER = 'createTypeParameter';

    /**
     * Triggered when the converter has found a function implementation.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_FUNCTION_IMPLEMENTATION = 'functionImplementation';

    /**
     * Resolve events
     */

    /**
     * Triggered when the converter begins resolving a project.
     * The listener should implement [[IConverterCallback]].
     * @event
     */
    static EVENT_RESOLVE_BEGIN = 'resolveBegin';

    /**
     * Triggered when the converter resolves a reflection.
     * The listener should implement [[IConverterResolveCallback]].
     * @event
     */
    static EVENT_RESOLVE = 'resolveReflection';

    /**
     * Triggered when the converter has finished resolving a project.
     * The listener should implement [[IConverterCallback]].
     * @event
     */
    static EVENT_RESOLVE_END = 'resolveEnd';

    /**
     * Create a new Converter instance.
     *
     * @param application  The application instance this converter relies on. The application
     *   must expose the settings that should be used and serves as a global logging endpoint.
     */
    initialize() {
        this.compilerHost = new CompilerHost(this);
        this.nodeConverters = {};
        this.typeTypeConverters = [];
        this.typeNodeConverters = [];
    }

    addComponent<T extends ConverterComponent & Component>(name: string, componentClass: T | ComponentClass<T>): T {
        const component = super.addComponent(name, componentClass);
        if (component instanceof ConverterNodeComponent) {
            this.addNodeConverter(component);
        } else if (component instanceof ConverterTypeComponent) {
            this.addTypeConverter(component);
        }

        return component;
    }

    private addNodeConverter(converter: ConverterNodeComponent<any>) {
        for (let supports of converter.supports) {
            this.nodeConverters[supports] = converter;
        }
    }

    private addTypeConverter(converter: ConverterTypeComponent) {
        if ('supportsNode' in converter && 'convertNode' in converter) {
            this.typeNodeConverters.push(<TypeNodeConverter<any, any>> converter);
            this.typeNodeConverters.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        }

        if ('supportsType' in converter && 'convertType' in converter) {
            this.typeTypeConverters.push(<TypeTypeConverter<any>> converter);
            this.typeTypeConverters.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        }
    }

    removeComponent(name: string): ConverterComponent {
        const component = super.removeComponent(name);
        if (component instanceof ConverterNodeComponent) {
            this.removeNodeConverter(component);
        } else if (component instanceof ConverterTypeComponent) {
            this.removeTypeConverter(component);
        }

        return component;
    }

    private removeNodeConverter(converter: ConverterNodeComponent<any>) {
        const converters = this.nodeConverters;
        const keys = _.keys(this.nodeConverters);
        for (let key of keys) {
            if (converters[key] === converter) {
                delete converters[key];
            }
        }
    }

    private removeTypeConverter(converter: ConverterTypeComponent) {
        const typeIndex = this.typeTypeConverters.indexOf(<any> converter);
        if (typeIndex !== -1) {
            this.typeTypeConverters.splice(typeIndex, 1);
        }

        const nodeIndex = this.typeNodeConverters.indexOf(<any> converter);
        if (nodeIndex !== -1) {
            this.typeNodeConverters.splice(nodeIndex, 1);
        }
    }

    removeAllComponents() {
        super.removeAllComponents();

        this.nodeConverters = {};
        this.typeTypeConverters = [];
        this.typeNodeConverters = [];
    }

    /**
     * Compile the given source files and create a project reflection for them.
     *
     * @param fileNames  Array of the file names that should be compiled.
     */
    convert(fileNames: string[]): ConverterResult {
        for (let i = 0, c = fileNames.length; i < c; i++) {
            fileNames[i] = normalizePath(_ts.normalizeSlashes(fileNames[i]));
        }

        const program = ts.createProgram(fileNames, this.application.options.getCompilerOptions(), this.compilerHost);
        const checker = program.getTypeChecker();
        const context = new Context(this, fileNames, checker, program);

        this.trigger(Converter.EVENT_BEGIN, context);

        const errors = this.compile(context);
        const project = this.resolve(context);

        this.trigger(Converter.EVENT_END, context);

        return {
            errors: errors,
            project: project
        };
    }

    /**
     * Analyze the given node and create a suitable reflection.
     *
     * This function checks the kind of the node and delegates to the matching function implementation.
     *
     * @param context  The context object describing the current state the converter is in.
     * @param node     The compiler node that should be analyzed.
     * @return The resulting reflection or NULL.
     */
    convertNode(context: Context, node: ts.Node): Reflection {
        if (context.visitStack.indexOf(node) !== -1) {
            return null;
        }

        const oldVisitStack = context.visitStack;
        context.visitStack = oldVisitStack.slice();
        context.visitStack.push(node);

        let result: Reflection;
        if (node.kind in this.nodeConverters) {
            result = this.nodeConverters[node.kind].convert(context, node);
        }

        context.visitStack = oldVisitStack;
        var comment = getRawComment(node);

        if (result && comment != null && comment.indexOf('@notSupportedIn') != -1) {
            var tagRegex = /@(?:notSupportedIn)\s*((?:[\w]+, )*[\w]+)/g;

            result.comment = parseComment(comment.replace(tagRegex, ''));

            var tag = tagRegex.exec(comment);

            if (!result.comment.tags) {
                result.comment.tags = [];
            }

            let tagValue = tag[1];
            const tagValueInfo = this.application.notSupportedFeaturesConfig[tagValue];
            if (tagValueInfo) {
                tagValue = `<a href="${tagValueInfo.link}">${tagValueInfo.name}</a>`
            }
            result.comment.tags.push(new CommentTag('not supported in', '', tagValue));
            result.notSupportedIn = tag[1].split(/,\s?/);
        }

        if (result && comment != null && comment.indexOf('@componentOptions') != -1) {
            result.setFlag(ReflectionFlag.CoveoComponentOptions, true);
        }

        if (result && result instanceof DeclarationReflection) {
            var declarationReflection: DeclarationReflection = <DeclarationReflection>result;
            if (declarationReflection.extendedTypes) {
                declarationReflection.extendedTypes.forEach((type) => {
                    if (type.toString().toLowerCase() == 'component') {
                        result.kind = ReflectionKind.CoveoComponent;
                    }
                })
            }

            if (declarationReflection.implementedTypes) {
                declarationReflection.implementedTypes.forEach((impl) => {
                    if (impl.toString().toLowerCase().indexOf('icomponentbindings') >= 0) {
                        result.kind = ReflectionKind.CoveoComponent;
                    }
                })
            }
        }


        return result;
    }

    /**
     * Convert the given TypeScript type into its TypeDoc type reflection.
     *
     * @param context  The context object describing the current state the converter is in.
     * @param node  The node whose type should be reflected.
     * @param type  The type of the node if already known.
     * @returns The TypeDoc type reflection representing the given node and type.
     */
    convertType(context: Context, node?: ts.Node, type?: ts.Type): Type {
        // Run all node based type conversions
        if (node) {
            type = type || context.getTypeAtLocation(node);

            for (let converter of this.typeNodeConverters) {
                if (converter.supportsNode(context, node, type)) {
                    return converter.convertNode(context, node, type);
                }
            }
        }

        // Run all type based type conversions
        if (type) {
            for (let converter of this.typeTypeConverters) {
                if (converter.supportsType(context, type)) {
                    return converter.convertType(context, type);
                }
            }
        }
    }

    /**
     * Compile the files within the given context and convert the compiler symbols to reflections.
     *
     * @param context  The context object describing the current state the converter is in.
     * @returns An array containing all errors generated by the TypeScript compiler.
     */
    private compile(context: Context): ReadonlyArray<ts.Diagnostic> {
        const program = context.program;

        const appDirectory = this.compilerHost.currentDirectory;        
        program.getSourceFiles().forEach((sourceFile) => {
            if(!Path.isAbsolute(sourceFile.fileName)) {
              sourceFile.fileName = normalizePath(_ts.normalizeSlashes(Path.join(appDirectory, sourceFile.fileName)));
            }
            this.convertNode(context, sourceFile);
        });

        let diagnostics = program.getOptionsDiagnostics();
        if (diagnostics.length) {
            return diagnostics;
        }

        diagnostics = program.getSyntacticDiagnostics();
        if (diagnostics.length) {
            return diagnostics;
        }

        diagnostics = program.getGlobalDiagnostics();
        if (diagnostics.length) {
            return diagnostics;
        }

        diagnostics = program.getSemanticDiagnostics();
        if (diagnostics.length) {
            return diagnostics;
        }

        return [];
    }

    /**
     * Resolve the project within the given context.
     *
     * @param context  The context object describing the current state the converter is in.
     * @returns The final project reflection.
     */
    private resolve(context: Context): ProjectReflection {
        this.trigger(Converter.EVENT_RESOLVE_BEGIN, context);
        const project = context.project;

        for (let id in project.reflections) {
            if (!project.reflections.hasOwnProperty(id)) {
                continue;
            }
            this.trigger(Converter.EVENT_RESOLVE, context, project.reflections[id]);
        }

        this.trigger(Converter.EVENT_RESOLVE_END, context);
        return project;
    }

    /**
     * Return the basename of the default library that should be used.
     *
     * @returns The basename of the default library.
     */
    getDefaultLib(): string {
        return ts.getDefaultLibFileName(this.application.options.getCompilerOptions());
    }
}
