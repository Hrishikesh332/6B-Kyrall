"""Native Flask routing with Pydantic input validation and OpenAPI generation."""
from dataclasses import dataclass, field
from functools import wraps
import inspect
import re
from types import SimpleNamespace
from flask import Flask, request, jsonify, Response, send_file
from pydantic import BaseModel, TypeAdapter, Field, ValidationError
from typing import Annotated
from werkzeug.exceptions import HTTPException as WerkzeugHTTPException


@dataclass
class Parameter:
    default: object = None
    source: str = 'query'
    constraints: dict = field(default_factory=dict)


def Query(default=None, **constraints): return Parameter(default, 'query', constraints)
def Header(default=None, **constraints): return Parameter(default, 'header', constraints)
def File(default=...): return Parameter(default, 'file')


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code, self.detail = status_code, detail


def FileResponse(path, filename=None, media_type=None, headers=None):
    response = send_file(path, mimetype=media_type, as_attachment=filename is not None,
                         download_name=filename)
    if headers: response.headers.update(headers)
    return response


class API(Flask):
    def __init__(self):
        super().__init__(__name__, static_folder=None)
        self.state = SimpleNamespace()
        self.schema = {'openapi': '3.1.0', 'info': {'title': '6B Flask API', 'version': '0.2.0'},
                       'paths': {}, 'components': {'schemas': {}}}
        self.config.update(MAX_CONTENT_LENGTH=12*1024*1024,
                           TRUSTED_HOSTS=['localhost', '127.0.0.1', '[::1]', 'testserver'])
        self.add_url_rule('/openapi.json', 'openapi', lambda: jsonify(self.schema))
        self.register_error_handler(ValidationError, lambda exc: (jsonify(detail=exc.errors(include_context=False, include_input=False)), 422))
        self.register_error_handler(HTTPException, lambda exc: (jsonify(detail=exc.detail), exc.status_code))
        self.register_error_handler(WerkzeugHTTPException, lambda exc: (jsonify(detail=exc.description), exc.code))

    def endpoint(self, path, method, status_code=200, include_in_schema=True):
        def decorate(fn):
            signature = inspect.signature(fn)
            parameters, request_body = [], None
            for name, param in signature.parameters.items():
                kind = param.default if isinstance(param.default, Parameter) else Parameter(param.default)
                annotation = param.annotation
                if inspect.isclass(annotation) and issubclass(annotation, BaseModel):
                    schema = annotation.model_json_schema(ref_template='#/components/schemas/{model}')
                    self.schema['components']['schemas'].update(schema.pop('$defs', {}))
                    self.schema['components']['schemas'][annotation.__name__] = schema
                    request_body = {'required': True, 'content': {'application/json': {'schema': {'$ref': '#/components/schemas/'+annotation.__name__}}}}
                elif kind.source == 'file':
                    request_body = {'required': True, 'content': {'multipart/form-data': {'schema': {'type':'object','required':['file'],'properties':{'file':{'type':'string','format':'binary'}}}}}}
                else:
                    location = 'path' if '{'+name+'}' in path else kind.source
                    schema = TypeAdapter(Annotated[annotation, Field(**kind.constraints)]).json_schema()
                    parameters.append({'name':name.replace('_','-') if location=='header' else name,
                                       'in':location,'required':location=='path','schema':schema})
            if include_in_schema:
                operation = {'summary': fn.__name__.replace('_',' ').title(), 'parameters': parameters,
                             'responses': {str(status_code): {'description':'Success'}, '422': {'description':'Invalid input'}}}
                if request_body: operation['requestBody'] = request_body
                self.schema['paths'].setdefault(path, {})[method.lower()] = operation

            @wraps(fn)
            def view(**path_params):
                kwargs = {}
                for name, param in signature.parameters.items():
                    if name in path_params:
                        kwargs[name] = path_params[name]; continue
                    annotation = param.annotation
                    kind = param.default if isinstance(param.default, Parameter) else Parameter(param.default)
                    if inspect.isclass(annotation) and issubclass(annotation, BaseModel):
                        kwargs[name] = annotation.model_validate(request.get_json())
                        continue
                    if kind.source == 'file':
                        if name not in request.files: raise HTTPException(422,'File is required')
                        kwargs[name] = request.files[name]; continue
                    source = request.headers if kind.source=='header' else request.args
                    key = name.replace('_','-') if kind.source=='header' else name
                    value = source.get(key, kind.default)
                    kwargs[name] = TypeAdapter(Annotated[annotation, Field(**kind.constraints)]).validate_python(value)
                result = fn(**kwargs)
                if isinstance(result, Response): return result
                return jsonify(result), status_code
            rule = re.sub(r'\{([^}]+)\}', r'<\1>', path)
            self.add_url_rule(rule, fn.__name__, view, methods=[method])
            return fn
        return decorate

    def get(self, path, **kwargs): return self.endpoint(path,'GET',**kwargs)
    def post(self, path, **kwargs): return self.endpoint(path,'POST',**kwargs)
    def patch(self, path, **kwargs): return self.endpoint(path,'PATCH',**kwargs)
    def put(self, path, **kwargs): return self.endpoint(path,'PUT',**kwargs)
    def delete(self, path, **kwargs): return self.endpoint(path,'DELETE',**kwargs)
